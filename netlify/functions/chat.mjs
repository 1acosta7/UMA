import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
  CORS, jsonError, requireUser, looksLikePdf, clientDocPrefix,
  loadConversation, saveConversation, logAccess, readAccessLog,
  CARRIERS, CARRIER_NAMES, SLOT_LABELS,
} from "./_shared.mjs";

const EMBEDDING_MODEL = "text-embedding-3-small";

const SYSTEM_PROMPT = `You are my personal life insurance underwriting assistant. I am a licensed life insurance professional. Your job is to help me determine which carriers will approve my clients and at what rate class, based on their health profile.

---

WHAT I WILL GIVE YOU:
For each client, I will provide:
- Age, gender, height, weight
- Tobacco/nicotine use (type, frequency, last use)
- Medical history (diagnoses, dates, medications, surgeries)
- Family history (parents/siblings, cause of death, age at death)
- Financial information if relevant (income, net worth for large face amounts)
- Desired coverage amount and product type

---

YOUR KNOWLEDGE BASE:
I have uploaded underwriting guidelines for the following carriers and products into this project. Use ONLY this uploaded material to make decisions. Do not guess or use general knowledge for carrier-specific rules.

---

UMA Decision Process — Underwriting Placement Logic

You are not a search engine that dumps retrieved text. You are an underwriter making a placement call. Follow this sequence internally before writing any response:

1. Find the binding constraint. Scan the client profile for the condition(s) with a hard numeric/threshold trigger (A1C cutoffs, build charts, medication tiers, duration-since-diagnosis rules) that varies by carrier and could realistically flip accept→decline. Ignore conditions that are near-universal Accept/Select (mild anxiety, mild osteoarthritis) as decision drivers.
2. Choose elimination order by case type, not habit. FE-range case → check nonmed/simplified-issue first. Skip nonmed and go straight to FE-chart/fully-underwritten carriers if: face amount exceeds simplified-issue caps, a condition is an outright nonmed decline regardless of severity (e.g. insulin use), or it's a term/IUL case where nonmed isn't relevant.
3. Decide what to show. Silently omit a carrier if its decline is clean and near-certain from the guideline text. Explicitly name a ruled-out carrier only if: the user asked about it, it's their normal default carrier, or the reason it's excluded is itself useful (e.g. not in the knowledge base).
4. Check stacking per-carrier, every time. Never assume independence or stacking. Look for explicit language. If a carrier is silent on stacking, flag it as uncertain.
5. Commit vs. hedge. Commit to one answer when guideline text resolves the case with no interpretation gap. Hedge/ask ONLY when missing data could change the category of outcome (accept vs. decline) — never for data that would only shift the degree (Select vs. Preferred).
6. Rank by certainty, then price. When multiple carriers are viable, lead with the most certain acceptance, not the cheapest.
7. Default to short-form. Lead with: carrier + product + expected rate class, 2-4 lines. Then 1-2 sentences per condition, each citing the specific rule that drove it. No Client Snapshot header, no full carrier-by-carrier writeup — unless step 8 applies.
8. Escalate to long-form only when: there's a real strategic fork (cash-value design tradeoffs, face amount vs. rate class vs. speed tradeoffs), or the user is building something for a client conversation rather than asking "who takes this case."
9. Missing data: blocker or workaround? Blocker (ask before answering) only if it feeds a pass/fail table directly (build chart, duration cutoff). Otherwise, state the assumption and proceed.

Always required, no matter the format: every rate-class claim must trace to actual guideline text retrieved — quote or cite the specific rule, page, or table. Never state a rate class with confidence unless you can point to where it came from.

---

IMPORTANT RULES:
- If a client's condition falls in a gray area per step 5 above, say so clearly and suggest an informal inquiry
- Never guarantee approval — frame everything as "likely" or "based on guidelines"
- If I haven't uploaded guidelines for a carrier yet, tell me rather than guessing`;

// Applied only to the USER turn of a follow-up question, never to the
// system prompt. Short-form is already the default per the decision
// process above, but a follow-up narrows scope further -- it's answering
// one new question, not re-running the full triage/placement call.
const FOLLOWUP_PREFIX = "(Follow-up question on this same client -- answer it directly and concisely. Don't re-run the full placement analysis or restate carriers already covered unless the question requires it.)";

// Triage step, run once at the start of a conversation -- the result stays
// fixed for the life of that conversation (mid-conversation re-triage is
// intentionally out of scope, matching the existing no-mid-conversation-
// carrier-expansion design). This is what steps 1-2 of the Decision Process
// need to happen BEFORE retrieval, not just before writing: which condition
// is the binding constraint, what elimination order the case type calls
// for, and -- per carrier -- whether the case can plausibly be resolved
// from narrative guidance alone (a clean, condition-based decline that
// doesn't depend on a numeric table lookup) or genuinely needs the full
// native rate-class tables loaded. This model NEVER produces the
// underwriting analysis itself -- that always runs on claude-sonnet-5 below,
// and it still makes its own final call from whatever guideline text it
// actually receives; this step only controls what gets retrieved.
const TRIAGE_SYSTEM = `You are triaging a life insurance case before underwriting retrieval, given a client profile and the list of underwriting guideline documents actually available per carrier.

Determine:
1. bindingConstraint -- the condition(s) with a hard numeric/threshold trigger (A1C cutoffs, build charts, medication tiers, duration-since-diagnosis rules) that could realistically flip accept to decline. Ignore near-universal Accept/Select conditions as decision drivers.
2. caseType -- one short phrase describing the case for elimination-order purposes (e.g. "FE-range, nonmed-eligible", "FE-range, outright nonmed decline on insulin use", "term case, nonmed not relevant", "large face IUL").
3. Per carrier that has at least one available document:
   - docs: which documents to load, following these rules -- always include general/main underwriting guides, impairment guides, or medical reference guides (they contain the core condition-to-rate-class tables); only include a narrow population-specific document (diabetes-specific, foreign national/immigration, professional athletes, military/government-employee, children's/juvenile) if the profile clearly matches that population; never include purely administrative/process documents (telephone interview guides, APS ordering guides). If unsure whether a document applies, include it.
   - tier -- "full" or "narrative_only". HARD RULE: if bindingConstraint involves ANY quantifiable clinical value (A1C, blood pressure, PSA, build/BMI, lab result, dosage, duration in years/months) as opposed to a purely binary/named-condition trigger, tier MUST be "full" for every carrier that has a general/impairment/medical-reference document available -- a numeric value can always land inside a table's boundary in a way narrative text won't state, so narrative_only is never safe for it, regardless of how the narrative text reads. Only use "narrative_only" when bindingConstraint itself is a flat, named-condition trigger with no numeric axis (e.g. "insulin use", "currently smokes") AND you are confident the narrative text states the outcome outright. Default to "full" whenever unsure -- narrative_only skips loading the tables entirely for that carrier, so getting it wrong there costs more than getting it wrong the other way.

Return JSON only:
{"bindingConstraint": "...", "caseType": "...", "carriers": {"<carrier_id>": {"docs": ["slotId1","slotId2"], "tier": "full"|"narrative_only"}}}`;

function deriveLabel(profileText, replyText) {
  const m = replyText.match(/-\s*Name \(or initials\):\s*(.+)/i);
  const name = m?.[1]?.trim();
  const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (name && !/^_+$/.test(name)) return `${name} — ${dateStr}`;
  const snippet = profileText.trim().replace(/\s+/g, " ").slice(0, 40);
  return `${snippet}${profileText.length > 40 ? "…" : ""} — ${dateStr}`;
}

// Builds native PDF document blocks for a carrier's selected guideline slots,
// validating each blob actually looks like a PDF (guards against stale
// entries from a prior storage format) and gracefully downgrading a carrier
// to "none" if every one of its selected docs turns out invalid, rather than
// failing the whole request. A carrier triaged "narrative_only" never has its
// (often large) native rate tables loaded at all -- this is the retrieval-
// side half of "don't just loop over every carrier and load everything";
// the model still gets that carrier's narrative guidance separately.
async function buildCarrierContentBlocks(store, slotIdsByCarrier, carrierStatus, tierByCarrier = {}) {
  const contentBlocks = [];
  for (const carrier of CARRIERS) {
    const name = CARRIER_NAMES[carrier];
    if (carrierStatus[carrier] === "none") {
      contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()}: NO GUIDELINES UPLOADED FOR THIS CARRIER ===` });
      continue;
    }
    if (tierByCarrier[carrier] === "narrative_only") {
      contentBlocks.push({
        type: "text",
        text: `\n\n=== ${name.toUpperCase()}: FULL RATE TABLES NOT LOADED -- TRIAGED AS RESOLVABLE FROM NARRATIVE GUIDANCE ALONE FOR THIS CASE. If the narrative guidance below doesn't actually settle this carrier's outcome, say so explicitly rather than guessing a rate class. ===`,
      });
      continue;
    }
    const slotIds = slotIdsByCarrier[carrier] || [];
    const docBlocks = [];
    for (const slotId of slotIds) {
      const key = `${carrier}_${slotId}`;
      try {
        const buf = await store.get(key, { type: "arrayBuffer" });
        if (!buf) continue;
        const bytes = new Uint8Array(buf);
        if (!looksLikePdf(bytes)) continue;
        docBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: Buffer.from(buf).toString("base64") },
          title: `${name} — ${SLOT_LABELS[carrier]?.[slotId] || slotId}`,
          citations: { enabled: true },
        });
      } catch { /* skip unreadable doc */ }
    }
    if (docBlocks.length === 0) {
      carrierStatus[carrier] = "none";
      contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()}: NO GUIDELINES UPLOADED FOR THIS CARRIER ===` });
      continue;
    }
    contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()} GUIDELINE DOCUMENTS ===` });
    contentBlocks.push(...docBlocks);
  }
  return contentBlocks;
}

// Client medical documents are immutable once uploaded (no mid-conversation
// attach in v1), so re-listing this prefix always yields the same set on
// every call -- initial or follow-up -- with no extra bookkeeping needed.
async function buildClientDocBlocks(store, userId, conversationId) {
  const contentBlocks = [];
  const keys = [];
  let blobs = [];
  try {
    ({ blobs } = await store.list({ prefix: clientDocPrefix(userId, conversationId) }));
  } catch { /* no client docs */ }
  if (blobs.length === 0) return { contentBlocks, keys };

  contentBlocks.push({ type: "text", text: "\n\n=== CLIENT-PROVIDED MEDICAL DOCUMENTS ===" });
  for (const b of blobs) {
    try {
      const buf = await store.get(b.key, { type: "arrayBuffer" });
      if (!buf) continue;
      const bytes = new Uint8Array(buf);
      if (!looksLikePdf(bytes)) continue;
      const filename = b.metadata?.filename || b.key.split("/").pop();
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(buf).toString("base64") },
        title: `Client Document — ${filename}`,
        citations: { enabled: true },
      });
      keys.push(b.key);
    } catch { /* skip unreadable doc */ }
  }
  return { contentBlocks, keys };
}

// Runs once, at the initial analysis call: embeds the client profile and
// searches each carrier's narrative-guidance chunks in Supabase/pgvector
// (the hybrid pipeline's non-tabular content -- process guidance, exclusion
// criteria, eligibility rules -- table-heavy content never enters this
// store at all, see _ingest.mjs). Results are persisted onto the record as
// plain text and simply replayed on follow-ups, so a follow-up never
// re-queries and the context a client's thread was analyzed against never
// silently drifts if the corpus changes later.
async function buildNarrativeGuidanceBlocks(queryText) {
  const contentBlocks = [];
  const narrativeStatus = {};

  let supabase, openai;
  try {
    supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_KEY"));
    openai = new OpenAI({ apiKey: Netlify.env.get("OPENAI_API_KEY") });
  } catch {
    for (const carrier of CARRIERS) narrativeStatus[carrier] = "none";
    return { contentBlocks, narrativeStatus };
  }

  let queryEmbedding;
  try {
    const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: [queryText] });
    queryEmbedding = res.data[0].embedding;
  } catch {
    for (const carrier of CARRIERS) narrativeStatus[carrier] = "none";
    return { contentBlocks, narrativeStatus };
  }

  for (const carrier of CARRIERS) {
    const name = CARRIER_NAMES[carrier];
    let hasAny = false;
    try {
      const { data } = await supabase.from("guideline_chunks").select("id").eq("carrier", carrier).limit(1);
      hasAny = (data?.length || 0) > 0;
    } catch { /* treat as none uploaded */ }

    if (!hasAny) {
      narrativeStatus[carrier] = "none";
      continue;
    }

    let matches = [];
    try {
      const { data } = await supabase.rpc("match_guideline_chunks", {
        query_embedding: queryEmbedding, match_carrier: carrier, match_count: 6,
      });
      matches = data || [];
    } catch { matches = []; }

    if (matches.length === 0) {
      // Hard fallback rule: guidelines ARE uploaded for this carrier, but
      // nothing matched this client's specific conditions -- say so
      // explicitly rather than silently omitting the carrier or guessing.
      narrativeStatus[carrier] = "no_match";
      contentBlocks.push({
        type: "text",
        text: `\n\n=== ${name.toUpperCase()}: NARRATIVE GUIDANCE IS UPLOADED FOR THIS CARRIER, BUT NO SPECIFIC GUIDANCE MATCHED THIS CLIENT'S STATED CONDITIONS ===`,
      });
      continue;
    }

    narrativeStatus[carrier] = "matched";
    const cited = matches
      .map((m) => {
        const doc = m.source_filename ? `${m.slot_label || m.slot_id} (${m.source_filename})` : (m.slot_label || m.slot_id);
        return `[${name} — ${doc}, page ${m.page_number}]: ${m.content}`;
      })
      .join("\n\n");
    contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()} NARRATIVE GUIDANCE (via search) ===\n${cited}` });
  }

  return { contentBlocks, narrativeStatus };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  const { conversationId, message, debug } = await req.json();
  if (!conversationId) return jsonError(400, "conversationId is required");
  if (!message?.trim()) return jsonError(400, "message is required");

  const anthropic = new Anthropic({ apiKey: Netlify.env.get("ANTHROPIC_API_KEY") });
  const carrierStore = getStore({ name: "carrier-docs", consistency: "strong" });
  const clientStore = getStore({ name: "client-docs", consistency: "strong" });
  const convStore = getStore({ name: "conversations", consistency: "strong" });

  let record = await loadConversation(convStore, userId, conversationId);
  const isFollowUp = !!(record && record.turns && record.turns.length > 0);

  let contentBlocks, tableStatus, narrativeStatus, mergedStatus, messages, selectedForRecord, tierForRecord, clientDocKeysForRecord, narrativeBlocksTextForRecord;

  if (!isFollowUp) {
    // ---- Initial analysis: discover, triage, and load documents ----
    let allKeys = [];
    try {
      const { blobs } = await carrierStore.list();
      allKeys = blobs.map((b) => b.key).sort();
    } catch { /* store empty or unavailable */ }

    tableStatus = {};
    const available = {};
    for (const carrier of CARRIERS) {
      const slotKeys = allKeys.filter((k) => k.startsWith(`${carrier}_`));
      if (slotKeys.length === 0) {
        tableStatus[carrier] = "none";
        continue;
      }
      tableStatus[carrier] = "uploaded";
      available[carrier] = slotKeys.map((k) => {
        const slotId = k.slice(carrier.length + 1);
        return { id: slotId, label: SLOT_LABELS[carrier]?.[slotId] || slotId };
      });
    }

    // Decision Process steps 1-2 happen here, before retrieval -- not just
    // before writing. The triage result gates which carriers get their full
    // native rate tables loaded (buildCarrierContentBlocks below); narrative
    // guidance is still fetched for every carrier regardless (see
    // buildNarrativeGuidanceBlocks) since that's the targeted, cheap half of
    // retrieval, not the part causing bloated context/output.
    let selected = {};
    let tierByCarrier = {};
    let triageContext = null;
    if (Object.keys(available).length > 0) {
      try {
        const triageMsg = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 1500,
          system: TRIAGE_SYSTEM,
          messages: [{
            role: "user",
            content: `CLIENT PROFILE:\n${message}\n\nAVAILABLE DOCUMENTS PER CARRIER:\n${JSON.stringify(available, null, 2)}`,
          }],
        });
        const triageText = triageMsg.content?.[0]?.text ?? "";
        const parsed = JSON.parse(triageText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
        for (const [carrier, info] of Object.entries(parsed.carriers || {})) {
          selected[carrier] = info.docs || [];
          tierByCarrier[carrier] = info.tier === "narrative_only" ? "narrative_only" : "full";
        }
        if (parsed.bindingConstraint || parsed.caseType) {
          triageContext = `\n\n=== CASE TRIAGE ===\nBinding constraint(s): ${parsed.bindingConstraint || "none identified"}\nCase type: ${parsed.caseType || "unspecified"}\n(Your own judgment on the guideline text below governs the final call -- this is a starting point, not a conclusion.)`;
        }
      } catch {
        // Triage failed -- fail open exactly like the doc-selection step
        // always did: load every available doc, full tier, for every
        // carrier, rather than silently under-retrieving.
        for (const carrier of Object.keys(available)) {
          selected[carrier] = available[carrier].map((d) => d.id);
          tierByCarrier[carrier] = "full";
        }
      }
    }
    selectedForRecord = selected;
    tierForRecord = tierByCarrier;

    contentBlocks = await buildCarrierContentBlocks(carrierStore, selected, tableStatus, tierByCarrier);
    if (triageContext) contentBlocks.unshift({ type: "text", text: triageContext });
    const { contentBlocks: narrativeBlocks, narrativeStatus: nStatus } = await buildNarrativeGuidanceBlocks(message);
    narrativeStatus = nStatus;
    narrativeBlocksTextForRecord = narrativeBlocks.map((b) => b.text);
    contentBlocks.push(...narrativeBlocks);

    const { contentBlocks: clientBlocks, keys: clientKeys } = await buildClientDocBlocks(clientStore, userId, conversationId);
    contentBlocks.push(...clientBlocks);
    clientDocKeysForRecord = clientKeys;

    if (contentBlocks.length) contentBlocks[contentBlocks.length - 1].cache_control = { type: "ephemeral" };

    messages = [{ role: "user", content: [...contentBlocks, { type: "text", text: message }] }];

    record = record || { id: conversationId, userId, createdAt: new Date().toISOString(), turns: [] };
  } else {
    // ---- Follow-up: reconstruct the established thread deterministically ----
    tableStatus = { ...record.tableStatus };
    narrativeStatus = { ...record.narrativeStatus };
    contentBlocks = await buildCarrierContentBlocks(carrierStore, record.carrierSelection || {}, tableStatus, record.tier || {});
    // Narrative guidance is never re-queried on a follow-up -- replay the
    // exact text the initial analysis was actually generated against.
    for (const text of record.narrativeBlocksText || []) {
      contentBlocks.push({ type: "text", text });
    }

    const { contentBlocks: clientBlocks } = await buildClientDocBlocks(clientStore, userId, conversationId);
    contentBlocks.push(...clientBlocks);
    if (contentBlocks.length) contentBlocks[contentBlocks.length - 1].cache_control = { type: "ephemeral" };

    messages = [{ role: "user", content: [...contentBlocks, { type: "text", text: record.profileText }] }];
    for (const t of record.turns) {
      messages.push({ role: t.role, content: [{ type: "text", text: t.text }] });
    }
    // Cache everything established so far -- only the new question below is fresh.
    const lastMsg = messages[messages.length - 1];
    lastMsg.content[lastMsg.content.length - 1].cache_control = { type: "ephemeral" };

    messages.push({ role: "user", content: `${FOLLOWUP_PREFIX}\n\n${message}` });
  }

  // A carrier only reads as "nothing uploaded" if BOTH the table-doc side
  // and the narrative-search side are empty for it -- either one alone is
  // enough to count as "checked" for display purposes.
  mergedStatus = {};
  for (const carrier of CARRIERS) {
    mergedStatus[carrier] = (tableStatus[carrier] !== "none" || narrativeStatus[carrier] !== "none") ? "uploaded" : "none";
  }

  if (debug) {
    return new Response(JSON.stringify({
      isFollowUp, tableStatus, narrativeStatus, mergedStatus,
      firstMessageBlockCount: messages[0].content.length, turnsSoFar: record.turns.length,
      accessLog: await readAccessLog(userId, conversationId),
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();
  const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      if (!isFollowUp) controller.enqueue(sse("meta", { carrierStatus: mergedStatus }));
      let replyText = "";
      try {
        // Thinking disabled: Netlify's function timeout leaves no room for
        // adaptive thinking's invisible reasoning phase on top of native PDF
        // processing -- see chat.mjs history for the earlier 60s timeout fix.
        // NOTE: `temperature` is deprecated/rejected outright by claude-sonnet-5
        // (confirmed via a live 400 "temperature is deprecated for this model")
        // -- there is currently no sampling-temperature knob for this model, so
        // determinism instead relies on thinking being disabled and the
        // documents/system prompt being the same on every call for a given
        // client, not an explicit temperature setting.
        const anthropicStream = anthropic.messages.stream({
          model: "claude-sonnet-5",
          max_tokens: 8000,
          thinking: { type: "disabled" },
          system: SYSTEM_PROMPT,
          messages,
        });
        for await (const event of anthropicStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            replyText += event.delta.text;
            controller.enqueue(sse("delta", { text: event.delta.text }));
          }
        }
      } catch (err) {
        controller.enqueue(sse("error", { error: err.message }));
        controller.close();
        return;
      }

      const now = new Date().toISOString();
      record.updatedAt = now;
      if (!isFollowUp) {
        record.profileText = message;
        record.carrierSelection = selectedForRecord;
        record.tier = tierForRecord;
        record.tableStatus = tableStatus;
        record.narrativeStatus = narrativeStatus;
        record.narrativeBlocksText = narrativeBlocksTextForRecord;
        record.carrierStatus = mergedStatus;
        record.clientDocKeys = clientDocKeysForRecord;
        record.turns.push({ role: "assistant", text: replyText });
        if (!record.label) record.label = deriveLabel(record.profileText, replyText);
      } else {
        record.turns.push({ role: "user", text: message });
        record.turns.push({ role: "assistant", text: replyText });
      }
      try {
        await saveConversation(convStore, userId, conversationId, record);
      } catch { /* if persistence fails, the reply still reached the user */ }
      await logAccess(userId, conversationId, isFollowUp ? "followup" : "analysis");

      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
