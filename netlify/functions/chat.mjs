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

// Verbatim, unmodified per the operator's Claude Project system prompt.
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

WHAT YOU WILL DO:
1. Review the client profile I provide
2. Cross-reference against each carrier's uploaded guidelines
3. For each carrier/product, tell me:
   - ✅ LIKELY APPROVED — and at what rate class (Preferred Plus, Preferred, Standard Plus, Standard, Table rating)
   - ⚠️ POSSIBLE ISSUES — flag any health conditions that may cause a rating or exclusion
   - ❌ LIKELY DECLINED — and the specific reason based on their guidelines
4. Rank carriers from most favorable to least favorable for this client
5. Suggest which product type fits best (term, IUL, whole life, final expense) based on their profile and any coverage limitations

---

OUTPUT FORMAT:
Use this structure every time:

CLIENT SNAPSHOT
- Name (or initials): 
- Age / Gender:
- Height / Weight / Build class:
- Tobacco: 
- Key Medical Flags:

CARRIER ANALYSIS
[Carrier Name] — [Product]
- Likely Outcome: ✅ / ⚠️ / ❌
- Estimated Rate Class:
- Notes / Flags:

RECOMMENDATION
- Best carrier option(s) for this client
- Product recommendation
- Any pre-submission notes (informal inquiry suggested, APS likely, etc.)

---

IMPORTANT RULES:
- Always cite the specific guideline or page from the uploaded documents when flagging an issue
- If a client's condition falls in a gray area, say so clearly and suggest an informal inquiry
- Never guarantee approval — frame everything as "likely" or "based on guidelines"
- If I haven't uploaded guidelines for a carrier yet, tell me rather than guessing`;

// Applied only to the USER turn of a follow-up question, never to the
// protected system prompt above (which must stay byte-for-byte verbatim).
// The system prompt's own "use this structure every time" line would
// otherwise fight the requirement that follow-ups be free-form.
const FOLLOWUP_PREFIX = "(Follow-up question on this same client -- a direct, free-form answer is fine, no need to repeat the full CLIENT SNAPSHOT/CARRIER ANALYSIS/RECOMMENDATION format for this.)";

// Narrow, disclosed auxiliary step: given the client profile and the list of
// documents actually uploaded per carrier, pick which ones are worth sending
// in full. Runs once, at the start of a conversation -- the selection then
// stays fixed for the life of that conversation (mid-conversation carrier
// expansion is intentionally out of scope). This model NEVER produces the
// underwriting analysis itself -- that always runs on claude-sonnet-5 below.
const DOC_SELECT_SYSTEM = `You are selecting which underwriting guideline documents to load for a specific client scenario, given a list of documents actually available per carrier.
Rules:
- Always include documents that are general/main underwriting guides, impairment guides, or medical reference guides -- these contain the core condition-to-rate-class decision tables and apply to nearly every case.
- Only include a narrow, population-specific document (diabetes-specific, foreign national/immigration, professional athletes, military/government-employee-specific, children's/juvenile products) if the client profile clearly matches that population.
- Never include purely administrative/process documents (e.g. telephone interview guides, APS ordering guides) -- they contain no condition-specific rate class decisions.
- If you are unsure whether a document applies, include it. Omitting a relevant document produces a wrong underwriting call; including an extra one only costs a bit of context.
Return JSON only: {"carrier_id": ["slotId1","slotId2"], ...} -- one array per carrier that has at least one available document, using the exact slot IDs given.`;

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
// failing the whole request.
async function buildCarrierContentBlocks(store, slotIdsByCarrier, carrierStatus) {
  const contentBlocks = [];
  for (const carrier of CARRIERS) {
    const name = CARRIER_NAMES[carrier];
    if (carrierStatus[carrier] === "none") {
      contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()}: NO GUIDELINES UPLOADED FOR THIS CARRIER ===` });
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
      .map((m) => `[${name} — ${m.slot_label || m.slot_id}, page ${m.page_number}]: ${m.content}`)
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

  let contentBlocks, tableStatus, narrativeStatus, mergedStatus, messages, selectedForRecord, clientDocKeysForRecord, narrativeBlocksTextForRecord;

  if (!isFollowUp) {
    // ---- Initial analysis: discover, select, and load documents ----
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

    let selected = {};
    if (Object.keys(available).length > 0) {
      try {
        const selMsg = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 1000,
          system: DOC_SELECT_SYSTEM,
          messages: [{
            role: "user",
            content: `CLIENT PROFILE:\n${message}\n\nAVAILABLE DOCUMENTS PER CARRIER:\n${JSON.stringify(available, null, 2)}`,
          }],
        });
        const selText = selMsg.content?.[0]?.text ?? "";
        selected = JSON.parse(selText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      } catch {
        for (const carrier of Object.keys(available)) {
          selected[carrier] = available[carrier].map((d) => d.id);
        }
      }
    }
    selectedForRecord = selected;

    contentBlocks = await buildCarrierContentBlocks(carrierStore, selected, tableStatus);
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
    contentBlocks = await buildCarrierContentBlocks(carrierStore, record.carrierSelection || {}, tableStatus);
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
