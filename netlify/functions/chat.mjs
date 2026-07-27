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

const SYSTEM_PROMPT = `You are an expert life insurance field underwriting assistant. I am a licensed life insurance professional. Your responsibility is to recommend the SINGLE BEST insurance product for my client, based only on the underwriting documents in your knowledge base. Your primary objective is accuracy.

---

WHAT I WILL GIVE YOU:
For each client: age, gender, state, height, weight, tobacco/nicotine use, medical conditions, medications, lab values, family history, desired coverage amount, and product objective.

If critical information is missing -- specifically anything that would change WHICH carrier or product wins, not just the exact rate class within an already-clear winner -- ask only those questions before continuing.

---

YOUR KNOWLEDGE BASE:
I have uploaded underwriting guidelines for the following carriers and products into this project. Use ONLY this uploaded material. Never use outside knowledge, never invent a rule, requirement, or recommendation that isn't in retrieved text.

---

CRITICAL RULE -- CARRIERS ARE INDEPENDENT
Never combine underwriting rules from different carriers. Treat every carrier as if it has its own independent underwriting department. Do not let one carrier's medical guidelines, build charts, prescription guides, or eligibility requirements influence another carrier's recommendation.

---

FEX / FINAL EXPENSE TERMINOLOGY
In final expense (FEX) documents, "Select" and "Graded" are BENEFIT LEVELS -- not rate tiers, not declines. "Select" means full immediate benefit; this IS a viable placement. "Graded" means benefits paid on a graded schedule; this IS also a viable placement. Only "Decline" or explicit exclusion language means no placement.
- The PRODUCT NAME is the FEX product (e.g., "FE Express Solution"). The RATE CLASS is what the condition chart shows ("Select Nontobacco" or "Graded"). Never swap these -- do not call the product "Graded FE Express" when the chart says Select.
- Use the client's actual tobacco status to select the correct row in any tobacco/non-tobacco table. Never output a rate class from the wrong tobacco row.

---

EVALUATION PROCESS -- follow every time, internally, before writing anything:

1. Find the binding constraint(s). Identify the condition(s), medication(s), or lab value(s) with a hard numeric/threshold trigger that varies by carrier and could realistically flip accept vs. decline. Ignore near-universal Accept/Select conditions as decision drivers.
2. Evaluate each carrier independently. For each carrier with guidelines uploaded: consider ONLY that carrier's retrieved guidance -- never cross-reference another carrier's chart while doing this -- check each condition, medication, and lab value against that carrier's own rules separately, determine the single best product that carrier offers this case, and assign a confidence level (High/Medium/Low) based only on what was actually retrieved for that carrier.
3. Check stacking per-carrier, every time. Never assume independence or stacking across conditions. Look for explicit language on comorbidity/stacking; if a carrier is silent on it, that uncertainty factors into its confidence level.
4. Compare only the recommended products. Once every carrier has a product + confidence, compare across carriers and select the single strongest overall fit, prioritizing in this order: highest likelihood of approval, best product fit, simplest underwriting path, least underwriting friction, strongest documentary evidence.
5. Commit vs. ask. Commit to a recommendation when guideline text resolves the case with no interpretation gap. Ask ONLY when missing data could change which carrier/product wins -- never for data that would only shift the degree within an already-clear winner.

---

FINAL RESPONSE FORMAT -- use this every time, by default:

Recommended Product
[Carrier Name] — [Product Name]

Why
[2-4 sentences on why this is the single strongest overall fit]

Source
[The specific document, rule, or page it traces to -- short, not a full citation dump]

Confidence
[High / Medium / Low]

Two optional trailing lines, only when they actually apply:
- If two carriers are genuinely close and there isn't a clear single winner: "Two strong options — ask if you want a comparison." Don't silently pick one and hide that it was close.
- If the winning recommendation itself is a gray-area/borderline call: "Borderline case — consider an informal inquiry before submitting."

Do not otherwise mention, in this default format: products or carriers that weren't selected, declined products/carriers, your internal reasoning, comparison tables, or full underwriting tables. The Source line is the one exception to "no citations visible" -- keep it short. If I ask for more detail or a comparison, give it then -- not by default.

If the retrieved documents don't provide enough evidence to make a recommendation, say exactly: "Additional underwriting information is required before a recommendation can be made." Do not guess. If I haven't uploaded guidelines for a carrier at all, that's the kind of gap worth naming rather than silently working around.

Act like an experienced senior field underwriter deciding which application to open first today. That is your final answer.`;

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
   - docs: which documents to load, following these rules -- always include general/main underwriting guides, impairment guides, or medical reference guides (they contain the core condition-to-rate-class tables); only include a narrow population-specific document (diabetes-specific, foreign national/immigration, professional athletes, military/government-employee, children's/juvenile) if the profile clearly matches that population; never include purely administrative/process documents (telephone interview guides, APS ordering guides). If unsure whether a document applies, include it. When a carrier has product-specific guides (final expense/FEX, term, whole life, IUL) instead of a single main guide: for clients aged 60+ OR with significant health impairments (diabetes on insulin, heart conditions, cancer history, COPD, BMI>40, etc.), ALWAYS include the final expense/FEX guide -- these have the most lenient underwriting and are often the only viable placement for impaired risk. When uncertain which product line applies, include all of them.
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

// A chunk's identity for dedup purposes across multiple searches (and across
// turns, once follow-ups can add to the accumulated set) -- no chunk `id` is
// returned by match_guideline_chunks, so this is a content-based key.
function dedupeKey(carrier, m) {
  return `${carrier}|${m.slot_id || m.slot_label || ""}|${m.page_number}|${(m.content || "").slice(0, 80)}`;
}

async function carriersWithNarrativeGuidelines(supabase) {
  const result = [];
  for (const carrier of CARRIERS) {
    try {
      const { data } = await supabase.from("guideline_chunks").select("id").eq("carrier", carrier).limit(1);
      if ((data?.length || 0) > 0) result.push(carrier);
    } catch { /* treat as none uploaded */ }
  }
  return result;
}

// Multi-query agentic research, not a single embedding per carrier: a cheap
// model issues its own sequence of searches against guideline_chunks. Every
// search is scoped to exactly one carrier -- "carrier" is a required tool
// argument, not optional -- because letting a search span multiple carriers
// is exactly the kind of blending the CRITICAL RULE in SYSTEM_PROMPT
// forbids: results from carrier A and carrier B would land in the same
// tool_result and start blending in the research model's own reasoning
// before the final model even sees them. Runs on claude-haiku-4-5 as a
// separate research pass (not the final claude-sonnet-5 call) so the
// expensive call that also reads native PDF tables stays a single
// non-looping streaming request; the loop here just produces a richer set
// of retrieved chunks, cleanly attributed per carrier, for that call to read.
const RESEARCH_SYSTEM = `You are researching a life insurance underwriting case in a vector database of carrier guideline narrative text, before final analysis is drafted. Carriers are fully independent -- never let what you find for one carrier shape how you search another.

For EACH carrier with guidelines uploaded, run a SEPARATE search_guidelines call, scoped to that one carrier, for EACH distinct medical condition, medication, and numeric lab value mentioned in the case. Never combine multiple conditions into one query, and never rely on a single broad search to cover a carrier -- if the case has 3 conditions and 4 carriers have guidelines uploaded, that is a minimum of 12 searches, not 3 or 4.

Search order: for each carrier, start with one search for its general/main underwriting guide or condition-to-rating table (broadest), then one targeted search per condition/medication/lab value against that same carrier. Finish covering one carrier before moving to the next. Never repeat the same query on the same carrier.

If the client is age 60+ or has multiple significant impairments, also run one search per carrier for "final expense underwriting criteria" and, for each significant impairment, a carrier-specific search for "[condition] select" (e.g. "diabetes insulin select"). FEX/final-expense products use condition-to-outcome decision charts where "Select" is a standard viable benefit level, not a decline -- finding "Select" next to a condition confirms placement is available at that level, and FEX guides are often the only viable placement for impaired-risk clients that standard products would decline.

Stop once every carrier with guidelines uploaded has been searched for every condition/medication/lab value in the case, or after 16 searches, whichever comes first. Do not pad the search count once coverage is complete.`;

async function researchNarrativeGuidance(anthropic, openai, supabase, queryText, carriersWithGuidelines) {
  if (carriersWithGuidelines.length === 0) return [];

  const tool = {
    name: "search_guidelines",
    description: "Search ONE carrier's underwriting guideline narrative text (process guidance, exclusion criteria, eligibility rules, informal-inquiry rules -- NOT rate-class tables, which come from native PDF documents provided separately). Every call is scoped to a single carrier -- there is no cross-carrier search. Returns the most relevant chunks with document and page citations.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search text for ONE condition, medication, lab value, or carrier-specific rule -- not a combination of several." },
        carrier: { type: "string", enum: carriersWithGuidelines, description: "The single carrier this search is scoped to. Required -- searches never span multiple carriers." },
      },
      required: ["query", "carrier"],
    },
  };

  const seen = new Set();
  const collected = [];
  const messages = [{
    role: "user",
    content: `CLIENT CASE:\n${queryText}\n\nCarriers with guidelines uploaded: ${carriersWithGuidelines.map((c) => CARRIER_NAMES[c]).join(", ")}`,
  }];

  const MAX_SEARCHES = 16;
  let searchCount = 0;

  for (let round = 0; round < MAX_SEARCHES + 1; round++) {
    let resp;
    try {
      resp = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: RESEARCH_SYSTEM,
        tools: [tool],
        messages,
      });
    } catch {
      break; // research failure -- proceed with whatever was collected so far
    }

    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: resp.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (searchCount >= MAX_SEARCHES) {
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "Search budget exhausted -- stop searching and proceed with what you have." });
        continue;
      }
      searchCount++;
      const carrier = carriersWithGuidelines.includes(tu.input?.carrier) ? tu.input.carrier : null;
      const query = String(tu.input?.query || "").slice(0, 500);
      let resultText = "No results.";
      if (!carrier) {
        resultText = "Missing or invalid carrier -- every search must specify exactly one carrier from the list provided.";
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
        continue;
      }
      try {
        const embRes = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: [query] });
        const embedding = embRes.data[0].embedding;
        const { data } = await supabase.rpc("match_guideline_chunks", { query_embedding: embedding, match_carrier: carrier, match_count: 4 });
        const hits = (data || []).map((m) => ({ ...m, carrier }));
        for (const m of hits) {
          const key = dedupeKey(m.carrier, m);
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push(m);
        }
        resultText = hits.length
          ? hits.map((m) => `[${CARRIER_NAMES[m.carrier]} — ${m.slot_label || m.slot_id}, page ${m.page_number}]: ${m.content}`).join("\n\n")
          : "No matching guidance found for this query.";
      } catch {
        resultText = "Search failed.";
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
    }
    messages.push({ role: "user", content: toolResults });
    if (searchCount >= MAX_SEARCHES) break;
  }

  return collected;
}

// Turns a flat, deduped chunk list into the same "=== CARRIER NARRATIVE
// GUIDANCE ===" text blocks the final model reads, plus per-carrier status.
// Takes the FULL accumulated chunk list (not just this turn's new finds) so
// a follow-up's additional research adds to what's known rather than
// replacing it -- see the follow-up branch below.
function formatNarrativeBlocks(allChunks, carriersWithGuidelines) {
  const contentBlocks = [];
  const narrativeStatus = {};
  const byCarrier = {};
  for (const m of allChunks) (byCarrier[m.carrier] ||= []).push(m);

  for (const carrier of CARRIERS) {
    const name = CARRIER_NAMES[carrier];
    if (!carriersWithGuidelines.includes(carrier)) {
      narrativeStatus[carrier] = "none";
      continue;
    }
    const matches = byCarrier[carrier] || [];
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
    contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()} NARRATIVE GUIDANCE (via multi-query search) ===\n${cited}` });
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

  let supabase = null, openai = null;
  try {
    supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_KEY"));
    openai = new OpenAI({ apiKey: Netlify.env.get("OPENAI_API_KEY") });
  } catch { /* narrative research degrades to "none" below if these are unavailable */ }

  let record = await loadConversation(convStore, userId, conversationId);
  const isFollowUp = !!(record && record.turns && record.turns.length > 0);

  let contentBlocks, tableStatus, narrativeStatus, mergedStatus, messages, selectedForRecord, tierForRecord, clientDocKeysForRecord, narrativeChunksForRecord;

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
    // guidance is still researched for every carrier regardless (see
    // researchNarrativeGuidance) since that's the targeted, cheap half of
    // retrieval, not the part causing bloated context/output.
    let selected = {};
    let tierByCarrier = {};
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
        // Deliberately NOT passed into the final call as context: the triage
        // model's bindingConstraint/caseType read is a retrieval-gating aid
        // only, never something claude-sonnet-5 should cite or defer to --
        // it isn't guideline text and doing so undermines the "every claim
        // traces to guideline text" rule. (An earlier version of this code
        // injected it as a "=== CASE TRIAGE ===" block; the model echoed
        // that header verbatim into user-visible output and treated it as
        // an authority independent of the actual retrieved documents.)
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

    // Multi-query research (steps 1-8 of RESEARCH_SYSTEM), not one embedding
    // per carrier -- see researchNarrativeGuidance above.
    narrativeStatus = {};
    for (const carrier of CARRIERS) narrativeStatus[carrier] = "none";
    let allChunks = [];
    if (supabase && openai) {
      try {
        const guidedCarriers = await carriersWithNarrativeGuidelines(supabase);
        allChunks = await researchNarrativeGuidance(anthropic, openai, supabase, message, guidedCarriers);
        const { contentBlocks: narrativeBlocks, narrativeStatus: nStatus } = formatNarrativeBlocks(allChunks, guidedCarriers);
        narrativeStatus = nStatus;
        contentBlocks.push(...narrativeBlocks);
      } catch { /* research failed -- narrativeStatus/allChunks stay at "none"/empty defaults above */ }
    }
    narrativeChunksForRecord = allChunks;

    const { contentBlocks: clientBlocks, keys: clientKeys } = await buildClientDocBlocks(clientStore, userId, conversationId);
    contentBlocks.push(...clientBlocks);
    clientDocKeysForRecord = clientKeys;

    if (contentBlocks.length) contentBlocks[contentBlocks.length - 1].cache_control = { type: "ephemeral" };

    messages = [{ role: "user", content: [...contentBlocks, { type: "text", text: message }] }];

    record = record || { id: conversationId, userId, createdAt: new Date().toISOString(), turns: [] };
  } else {
    // ---- Follow-up: reconstruct the established thread, but re-research ----
    tableStatus = { ...record.tableStatus };
    contentBlocks = await buildCarrierContentBlocks(carrierStore, record.carrierSelection || {}, tableStatus, record.tier || {});

    // A second retrieval round: new details in a follow-up (confirming
    // insulin use, providing build, etc.) can change what's worth finding,
    // so re-run research scoped to the new message rather than only ever
    // replaying the first pass. This is additive, not a replacement -- prior
    // chunks stay in context and newly-found ones are merged in, deduped,
    // so the accumulated knowledge for this case only grows across turns.
    const priorChunks = record.narrativeChunks || [];
    const priorKeys = new Set(priorChunks.map((m) => dedupeKey(m.carrier, m)));
    let allChunks = priorChunks;
    if (supabase && openai) {
      try {
        const guidedCarriers = await carriersWithNarrativeGuidelines(supabase);
        const researchQuery = `${record.profileText}\n\nNEW INFORMATION FROM A FOLLOW-UP MESSAGE: ${message}`;
        const found = await researchNarrativeGuidance(anthropic, openai, supabase, researchQuery, guidedCarriers);
        const newChunks = found.filter((m) => !priorKeys.has(dedupeKey(m.carrier, m)));
        allChunks = [...priorChunks, ...newChunks];
        const { contentBlocks: narrativeBlocks, narrativeStatus: nStatus } = formatNarrativeBlocks(allChunks, guidedCarriers);
        narrativeStatus = nStatus;
        contentBlocks.push(...narrativeBlocks);
      } catch {
        // Research failed on this turn -- fall back to whatever was already
        // established (old-format conversations from before this change
        // persisted pre-formatted text instead of raw chunks; new-format
        // ones fall back to re-formatting the unchanged prior chunk list).
        narrativeStatus = { ...record.narrativeStatus };
        if (priorChunks.length) {
          contentBlocks.push(...formatNarrativeBlocks(priorChunks, Object.keys(record.narrativeStatus || {}).filter((c) => record.narrativeStatus[c] !== "none")).contentBlocks);
        } else {
          for (const text of record.narrativeBlocksText || []) contentBlocks.push({ type: "text", text });
        }
      }
    } else {
      narrativeStatus = { ...record.narrativeStatus };
    }
    narrativeChunksForRecord = allChunks;

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
        // The stream can complete "successfully" (no thrown error) yet still
        // carry zero text -- e.g. stop_reason "refusal"/"max_tokens" with no
        // text block ever opened. Silently closing here used to surface as
        // an opaque "No analysis was returned" on the frontend with nothing
        // to debug from. Surface the actual stop_reason instead.
        if (!replyText) {
          let stopReason = "unknown";
          try {
            const final = await anthropicStream.finalMessage();
            stopReason = final?.stop_reason || stopReason;
          } catch { /* finalMessage best-effort only */ }
          controller.enqueue(sse("error", { error: `Model returned no text (stop_reason: ${stopReason}). Try again or narrow the client profile.` }));
          controller.close();
          return;
        }
      } catch (err) {
        controller.enqueue(sse("error", { error: err.message }));
        controller.close();
        return;
      }

      const now = new Date().toISOString();
      record.updatedAt = now;
      // narrativeChunks/narrativeStatus/carrierStatus are saved on every
      // turn, not just the initial one -- a follow-up's second retrieval
      // round can change all three, and each turn's re-research should
      // build on what the previous turn already found.
      record.narrativeChunks = narrativeChunksForRecord;
      record.narrativeStatus = narrativeStatus;
      record.carrierStatus = mergedStatus;
      if (!isFollowUp) {
        record.profileText = message;
        record.carrierSelection = selectedForRecord;
        record.tier = tierForRecord;
        record.tableStatus = tableStatus;
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
