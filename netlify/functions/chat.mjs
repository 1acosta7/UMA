import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import {
  CORS, jsonError, requireUser, looksLikePdf, clientDocPrefix,
  loadConversation, saveConversation, logAccess, readAccessLog,
  CARRIERS, CARRIER_NAMES, SLOT_LABELS, saveRecommendation,
} from "./_shared.mjs";
import { crossCheckBuild, crossCheckA1C, crossCheckPSA } from "./_lookup.mjs";
import { computeGuidelineVersionHash, buildIntakeCacheKey, getCachedRecommendation, saveCachedRecommendation } from "./_cache.mjs";

const EMBEDDING_MODEL = "text-embedding-3-small";

const SYSTEM_PROMPT = `You are an expert life insurance field underwriting assistant. I am a licensed life insurance professional. Your responsibility is to recommend the SINGLE BEST insurance product for my client, based only on the underwriting documents in your knowledge base. Your primary objective is accuracy.

---

WHAT I WILL GIVE YOU:
For each client: age, gender, state, height, weight, tobacco/nicotine use, medical conditions, medications, lab values, family history, desired coverage amount, and product objective.

If critical information is missing -- specifically anything that would change WHICH carrier or product wins, not just the exact rate class within an already-clear winner -- ask only those questions before continuing. Evaluate this per candidate winner, not globally: if one carrier's own chart already resolves to a specific, unconditional outcome for every condition given (no timeframe, duration, or severity qualifier attached to the matching line), that carrier is fully resolved and ready to recommend regardless of what missing detail would still be needed to evaluate a DIFFERENT carrier. Never let one carrier's need for more detail block or delay a recommendation that another carrier's own guidelines already fully support. Do not invent a question a carrier's own chart doesn't actually ask (e.g. asking about severity/duration for a condition whose chart entry has no such qualifier). This rule applies even when asking a question: never name a carrier anywhere in a clarifying question, and never explain a question by referencing what a specific carrier requires -- ask only about the clinical fact itself.

EXAMPLE (this exact pattern happens constantly -- do not miss it): Carrier A's single-condition chart lists "Rheumatoid arthritis — Select" with no severity/duration/medication qualifier attached to that line. Carrier B's chart requires knowing severity/medication before it can resolve rheumatoid arthritis at all. Carrier A is otherwise the strongest fit. Correct behavior: recommend Carrier A now, at Select, citing that unconditional line -- do NOT ask about rheumatoid arthritis severity. That question only matters for Carrier B, and Carrier B is not the recommendation, so its unresolved question is irrelevant to what you're about to tell me. The same logic applies to every condition independently, not just rheumatoid arthritis: check the WINNING carrier's own chart line for each of the client's conditions, and only ask about a condition if the winning carrier's OWN chart entry for it is genuinely ambiguous without more detail.

---

YOUR KNOWLEDGE BASE:
I have uploaded underwriting guidelines for the following carriers and products into this project. Use ONLY this uploaded material. Never use outside knowledge, never invent a rule, requirement, or recommendation that isn't in retrieved text.

---

CRITICAL RULE -- CARRIERS ARE INDEPENDENT
Never combine underwriting rules from different carriers. Treat every carrier as if it has its own independent underwriting department. Do not let one carrier's medical guidelines, build charts, prescription guides, or eligibility requirements influence another carrier's recommendation. This independence also governs commit-vs-ask: one carrier's ambiguity is never a reason to withhold a recommendation another carrier's own guidelines already resolve.

---

FEX / FINAL EXPENSE TERMINOLOGY
In final expense (FEX) documents, "Select" and "Graded" are BENEFIT LEVELS -- not rate tiers, not declines. "Select" means full immediate benefit; this IS a viable placement. "Graded" means benefits paid on a graded schedule; this IS also a viable placement. Only "Decline" or explicit exclusion language means no placement.
- The PRODUCT NAME is the FEX product (e.g., "FE Express Solution"). The RATE CLASS is what the condition chart shows ("Select Nontobacco" or "Graded"). Never swap these -- do not call the product "Graded FE Express" when the chart says Select.
- Use the client's actual tobacco status to select the correct row in any tobacco/non-tobacco table. Never output a rate class from the wrong tobacco row.

---

EVALUATION PROCESS -- follow every time, internally, before writing anything:

1. Find the binding constraint(s). Identify the condition(s), medication(s), or lab value(s) with a hard numeric/threshold trigger that varies by carrier and could realistically flip accept vs. decline. Ignore near-universal Accept/Select conditions as decision drivers.
2. Evaluate each carrier independently, as an explicit chain, not a vague impression. For each carrier with guidelines uploaded: consider ONLY that carrier's retrieved guidance -- never cross-reference another carrier's chart while doing this -- and for each condition, medication, and lab value, resolve it through this exact chain: the specific guideline text/page that governs it -> the client's specific data point for it -> whether it's a match or no-match against that guideline text -> the resulting rate class it implies. Determine the single best product that carrier offers this case, and assign a confidence level (High/Medium/Low) based only on what was actually retrieved for that carrier. The Source line you eventually write is not a separate citation you invent afterward -- it is a direct readout of this chain for the winning carrier. If you can't point to the specific chain step that produced your Source line, your Source line is wrong.
   IMPORTANT -- this chain-building rigor does not change the commit-vs-ask rule below, it feeds it: build the full chain for whichever carrier ends up winning, to the depth needed to write a grounded Source line for it. You do NOT need to fully resolve every condition against every OTHER carrier before you're allowed to commit -- a different carrier's incomplete or ambiguous chain is never, by itself, a reason to withhold a recommendation the winning carrier's own chain already resolves. Thoroughness here means "get the winner's chain right," not "block on exhaustively chaining every carrier first."
3. Check stacking per-carrier, every time. Never assume independence or stacking across conditions. Look for explicit language on comorbidity/stacking; if a carrier is silent on it, that uncertainty factors into its confidence level.
4. Compare only the recommended products. Once every carrier has a product + confidence, compare across carriers and select the single strongest overall fit, prioritizing in this order: highest likelihood of approval, best product fit, simplest underwriting path, least underwriting friction, strongest documentary evidence.
5. Commit vs. ask. Commit to a recommendation when guideline text resolves the case with no interpretation gap. Ask ONLY when missing data could change which carrier/product wins -- never for data that would only shift the degree within an already-clear winner.
6. Never write steps 1-4 out loud. You have no private scratchpad for this -- the reasoning above happens in your head before your first output token, not in a visible walkthrough. Your response is not a place to think; it is only the final answer.

---

FINAL RESPONSE FORMAT -- MANDATORY, use every time, by default:

Your reply contains ONLY the following, nothing before it and nothing after except the two optional lines noted below. The very first word of your response is "Recommended". No preamble, no summary of what you considered, no "Let me evaluate..." -- go straight to the format.

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

HARD RULE ON OTHER CARRIERS: the name of any carrier other than the one you're recommending must NEVER appear anywhere in your response -- not in a sentence explaining why it lost, not in a list of what you checked, not in a clause, nowhere. If you're about to type a second carrier's name, stop and delete that sentence instead. This is not a style preference -- a response naming a non-recommended carrier is a wrong response even if the recommendation itself is correct. Do not otherwise mention: your internal reasoning, comparison tables, full underwriting tables, or which conditions each carrier would have declined. The Source line is the one exception to "no citations visible" -- keep it short. If I ask for more detail or a comparison, give it then -- not by default.

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
   - docs: which documents to load. Every full-tier document you select is a complete multi-page PDF loaded into a single downstream call alongside every other carrier's selected documents -- there is a real, tight time budget for that call, so be deliberately minimal, not exhaustive. Selecting every plausible document "to be safe" is a bug, not a safety margin: it risks the call timing out and returning nothing at all, which is strictly worse than a slightly narrower but complete document set.
     * Always include general/main underwriting guides, impairment guides, or medical reference guides for the relevant product line (they contain the core condition-to-rate-class tables).
     * Only include a narrow population-specific document (diabetes-specific, foreign national/immigration, professional athletes, military/government-employee, children's/juvenile) if the profile clearly matches that population.
     * Never include purely administrative/process documents (telephone interview guides, APS ordering guides).
     * When a carrier has product-specific guides (final expense/FEX, term, whole life, IUL) instead of a single main guide: if the profile states an explicit product objective (final expense, term, permanent/whole life, IUL, a specific face-amount range implying final expense, etc.), include ONLY the document(s) for that stated product line -- do not also include unrelated product lines "for comparison." If the product objective is genuinely not stated: for clients aged 60+ OR with significant health impairments (diabetes on insulin, heart conditions, cancer history, COPD, BMI>40, etc.), include the final expense/FEX guide by default, since it has the most lenient underwriting and is often the only viable placement for impaired risk; otherwise include term and/or whole life. Only fall back to including every product line when you genuinely cannot tell which one applies even after considering age, impairment, and any stated coverage amount.
   - tier -- "full" or "narrative_only". HARD RULE: if bindingConstraint involves ANY quantifiable clinical value (A1C, blood pressure, PSA, build/BMI, lab result, dosage, duration in years/months) as opposed to a purely binary/named-condition trigger, tier MUST be "full" for every carrier that has a general/impairment/medical-reference document available -- a numeric value can always land inside a table's boundary in a way narrative text won't state, so narrative_only is never safe for it, regardless of how the narrative text reads. Only use "narrative_only" when bindingConstraint itself is a flat, named-condition trigger with no numeric axis (e.g. "insulin use", "currently smokes") AND you are confident the narrative text states the outcome outright. Default to "full" whenever unsure -- narrative_only skips loading the tables entirely for that carrier, so getting it wrong there costs more than getting it wrong the other way.

Return JSON only:
{"bindingConstraint": "...", "caseType": "...", "carriers": {"<carrier_id>": {"docs": ["slotId1","slotId2"], "tier": "full"|"narrative_only"}}}`;

// Runs BEFORE triage/research/final-analysis, purely to build the cache key
// (see _cache.mjs) -- a much simpler, more mechanical task than the
// underwriting reasoning it's gating, so it carries far less of the run-to-
// run variance risk than what it's replacing. A pure extraction task, not a
// judgment call: never infer or normalize a value that isn't explicitly
// stated (age band, rough weight, etc. -- if it's not exact, leave it null).
// If this extraction itself varies between two runs of literally identical
// text, the worst case is a cache MISS (falls back to running the full
// pipeline normally), never a wrong hit -- see buildIntakeCacheKey.
//
// diagnoses/medications/productObjective are the fields that actually
// varied between runs -- free-text fields the model was paraphrasing
// (different word choice, different grouping of qualifiers) rather than
// transcribing consistently. Fixed by separating WHAT (a canonical
// condition name, low-variance) from the qualifying DETAIL (broken into
// short atomic phrases in a consistent form, rather than one long freeform
// clause the model rephrases each time) and by sorting everything in code
// (buildIntakeCacheKey), so word-order is never a source of variance at
// all. Numeric fields (age, height/weight, coverage amount) are untouched
// -- they were already stable and are not part of this fix.
const INTAKE_SYSTEM = `You are extracting structured intake fields from a life insurance case description, for exact-match cache-key purposes only -- this is not an underwriting judgment. Extract ONLY values explicitly and exactly stated. Never infer, estimate, round, or normalize a NUMBER that isn't explicit (e.g. do not turn "mid-60s" into a specific age, do not convert an approximate weight into a number) -- if a field isn't stated as an exact value, leave it out entirely.

This is a TRANSCRIPTION task for diagnoses/medications/productObjective, not a summarization task. The single biggest source of error is paraphrasing the same clinical fact differently across two runs of identical input text -- follow these rules exactly, every time, so the same input always produces the same output:

DIAGNOSES -- for each distinct condition mentioned, output one entry with:
- "condition": the shortest standard medical name for it, lowercase, no extra words. Use the condition itself, never a synonym or expanded form -- "type 2 diabetes" not "diabetes mellitus type II" or "adult-onset diabetes"; "rheumatoid arthritis" not "RA"; "high blood pressure" not "hypertension" UNLESS the source text itself says "hypertension" (transcribe the term actually used, don't translate between equivalent terms).
- "modifiers": every qualifying detail about THAT condition, each as its own short atomic phrase, lowercase, in this exact form:
  * Negation of a sub-condition/complication: always "no X" (never "without X", "free of X", "absent X", "no history of X") -- e.g. "no neuropathy", "no retinopathy", "no kidney complications".
  * Treatment/medication status: always "on X" (never "taking X", "using X", "treated with X", "managed with X") -- e.g. "on insulin", "on humira".
  * Severity: a single word only -- "mild", "moderate", "severe".
  * Control status: "well-controlled" or "poorly controlled" (never "controlled", "under control", "not well managed", etc.)
  * One fact per modifier -- never combine two facts into one modifier string.
  Do not invent a modifier that isn't stated. Leave modifiers empty if none are given beyond the condition name itself.

MEDICATIONS -- the medication name only, lowercase, generic or brand exactly as stated (don't translate between brand/generic), no dosage or frequency detail unless that's the only thing distinguishing two otherwise-identical medication mentions.

PRODUCT OBJECTIVE -- classify into exactly one of the enum values on the tool schema. If the case describes it in different words than the enum label (e.g. "small final expense policy," "burial insurance"), map it to the correct enum value -- do not invent a new label.

Call record_client_intake exactly once.`;

const INTAKE_TOOL = {
  name: "record_client_intake",
  description: "Record the structured client intake fields explicitly and exactly stated in the case description.",
  input_schema: {
    type: "object",
    properties: {
      age: { type: "number" },
      sex: { type: "string", enum: ["male", "female"] },
      heightIn: { type: "number", description: "Total height in inches, only if an exact height is stated (convert feet/inches to total inches)." },
      weightLbs: { type: "number" },
      tobacco: { type: "string", enum: ["yes", "no"], description: "Only if tobacco/nicotine use is explicitly addressed either way." },
      medications: { type: "array", items: { type: "string" }, description: "Medication names only, lowercase, transcribed exactly as stated -- see system prompt." },
      diagnoses: {
        type: "array",
        description: "One entry per distinct condition -- see system prompt for exact canonicalization and modifier rules.",
        items: {
          type: "object",
          properties: {
            condition: { type: "string", description: "Shortest standard medical name, lowercase." },
            modifiers: { type: "array", items: { type: "string" }, description: "Atomic qualifying phrases in the required canonical form (no X / on X / severity word / control status)." },
          },
          required: ["condition"],
        },
      },
      coverageAmount: { type: "number" },
      productObjective: { type: "string", enum: ["final expense", "term", "whole life", "universal life", "iul", "annuity", "other"], description: "Only if a product objective is explicitly stated or clearly implied by a specific product/coverage type named." },
    },
  },
};

async function extractClientIntake(anthropic, message) {
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1000,
    system: INTAKE_SYSTEM,
    tools: [INTAKE_TOOL],
    tool_choice: { type: "tool", name: "record_client_intake" },
    messages: [{ role: "user", content: message }],
  });
  const toolUse = resp.content.find((b) => b.type === "tool_use" && b.name === "record_client_intake");
  return toolUse?.input || {};
}

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
    // Fetch every selected slot for this carrier concurrently -- these are
    // independent blob reads (often multi-MB PDFs), and a case that selects
    // several slots per carrier (e.g. all of a carrier's product lines) was
    // paying for each one sequentially before the analysis call could start.
    const fetched = await Promise.all(slotIds.map(async (slotId) => {
      const key = `${carrier}_${slotId}`;
      try {
        const buf = await store.get(key, { type: "arrayBuffer" });
        if (!buf) return null;
        const bytes = new Uint8Array(buf);
        if (!looksLikePdf(bytes)) return null;
        return {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: Buffer.from(buf).toString("base64") },
          title: `${name} — ${SLOT_LABELS[carrier]?.[slotId] || slotId}`,
          citations: { enabled: true },
        };
      } catch { return null; /* skip unreadable doc */ }
    }));
    const docBlocks = fetched.filter(Boolean);
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
  const checks = await Promise.all(CARRIERS.map(async (carrier) => {
    try {
      const { data } = await supabase.from("guideline_chunks").select("id").eq("carrier", carrier).limit(1);
      return (data?.length || 0) > 0 ? carrier : null;
    } catch { return null; /* treat as none uploaded */ }
  }));
  const result = checks.filter(Boolean);
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
    // Every search in a round is independent (scoped to its own carrier/query),
    // so run them concurrently instead of one embedding+RPC round-trip at a
    // time -- with up to 16 searches across 4 carriers, sequential execution
    // was eating a large chunk of the function's execution budget before the
    // final analysis call even started.
    const toolResults = await Promise.all(toolUses.map(async (tu) => {
      if (searchCount >= MAX_SEARCHES) {
        return { type: "tool_result", tool_use_id: tu.id, content: "Search budget exhausted -- stop searching and proceed with what you have." };
      }
      searchCount++;
      const carrier = carriersWithGuidelines.includes(tu.input?.carrier) ? tu.input.carrier : null;
      const query = String(tu.input?.query || "").slice(0, 500);
      if (!carrier) {
        return { type: "tool_result", tool_use_id: tu.id, content: "Missing or invalid carrier -- every search must specify exactly one carrier from the list provided." };
      }
      let resultText = "No results.";
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
      return { type: "tool_result", tool_use_id: tu.id, content: resultText };
    }));
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

// Everything needed to build the final model's `messages` array: loading or
// creating the conversation record, triage, document loading, and multi-
// query research. Factored out of the handler so both the debug path (which
// returns plain JSON, no streaming) and the real streaming path can share it
// -- the streaming path runs this INSIDE the stream's start() callback (see
// below) so the response opens and a heartbeat starts before any of this
// work begins, instead of after.
async function buildAnalysisContext({ anthropic, supabase, openai, carrierStore, clientStore, convStore, userId, conversationId, message }) {
  let record = await loadConversation(convStore, userId, conversationId);
  const isFollowUp = !!(record && record.turns && record.turns.length > 0);

  let contentBlocks, tableStatus, narrativeStatus, mergedStatus, messages, selectedForRecord, tierForRecord, clientDocKeysForRecord, narrativeChunksForRecord;
  let cacheKey = null;
  let intakeForDebug = null;

  if (!isFollowUp) {
    // ---- Consistency cache: check BEFORE triage/research/final-analysis ----
    // The whole point is to skip the pipeline stage that actually varies
    // (research's improvised search count/order, which changes what the
    // final model sees), not just cache its output after the fact. Scoped
    // to initial analysis only, not follow-ups -- a follow-up is contextual
    // conversation on an already-established thread, not a fresh case
    // lookup, so "identical input -> identical output" doesn't apply the
    // same way there.
    //
    // Attached client documents (uploaded via upload-client-doc.mjs before
    // analysis ever runs) are NOT represented in the structured-intake cache
    // key at all -- the key is built from the free-text profile's stated
    // fields only. Two conversations with identical intake text but
    // different attached PDFs could otherwise silently collide on the same
    // cache entry and ignore whatever's in the attachment. Conservative fix:
    // any attached client document forces a cache miss for this
    // conversation, every time, rather than risk that.
    let hasClientDocs = false;
    try {
      const { blobs } = await clientStore.list({ prefix: clientDocPrefix(userId, conversationId) });
      hasClientDocs = (blobs?.length || 0) > 0;
    } catch { /* treat as no client docs if the check itself fails */ }

    try {
      if (hasClientDocs) throw new Error("client documents attached -- skip cache");
      const intake = await extractClientIntake(anthropic, message);
      intakeForDebug = intake; // surfaced via debug:true only, for diagnosing cache-key instability
      const versionHash = await computeGuidelineVersionHash(supabase);
      cacheKey = buildIntakeCacheKey(intake, versionHash);
      const cached = await getCachedRecommendation(cacheKey);
      if (cached) {
        return {
          record: record || { id: conversationId, userId, createdAt: new Date().toISOString(), turns: [] },
          isFollowUp: false, cacheHit: true, cacheKey, intakeForDebug,
          cachedReplyText: cached.replyText,
          cachedRecommendation: cached.recommendation || null,
          tableStatus: cached.tableStatus || {}, narrativeStatus: cached.narrativeStatus || {},
          mergedStatus: cached.mergedStatus || {},
          selectedForRecord: cached.carrierSelection || {}, tierForRecord: cached.tier || {},
          clientDocKeysForRecord: [], narrativeChunksForRecord: cached.narrativeChunks || [],
          messages: null,
        };
      }
    } catch {
      // Intake extraction or the cache lookup itself failing must never
      // block the request -- just means this run can't be cached/served
      // from cache, and falls through to running the pipeline normally.
      cacheKey = null;
    }

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

  return {
    record, isFollowUp, cacheHit: false, cacheKey, intakeForDebug, tableStatus, narrativeStatus, mergedStatus, messages,
    selectedForRecord, tierForRecord, clientDocKeysForRecord, narrativeChunksForRecord,
  };
}

// Turns the finished, already-streamed prose answer into a schema-valid
// structured record, via a forced tool call on claude-haiku-4-5 -- not by
// asking the main claude-sonnet-5 call to interleave a full essay AND
// perfect nested JSON in one pass, and not by regex-parsing prose. Tool-use
// input is schema-guaranteed valid JSON, which free-text JSON emitted mid-
// stream is not.
//
// Important, disclosed limitation: this call does NOT re-attach the native
// PDF documents (that would reintroduce the exact prefill-timeout risk this
// session just fixed). It only sees the client profile, the final visible
// answer text, and the already-retrieved narrative chunks (plain text, not
// PDFs). Because the anti-carrier-naming rule means the visible answer never
// writes down non-winning carriers' reasoning, this call can only recover a
// well-grounded chain for the WINNING carrier from that text; for every
// other carrier, its chain entry will be well-grounded only if narrative
// chunks were retrieved for it, and marked "insufficient retrieved text"
// otherwise. This is a real, structural gap -- not a bug -- flagged in the
// implementation report.
const EXTRACT_SYSTEM = `You are converting a finished life insurance underwriting recommendation into a structured record. You are NOT re-deciding the case -- the recommendation was already made; your job is to faithfully represent what was concluded and why, using only the client profile, the final answer text, and the retrieved guideline excerpts you're given below.

Call record_structured_recommendation exactly once.

If the final answer was a clarifying question or an "insufficient evidence" response with no actual product recommendation, set hasRecommendation to false and omit the recommendation fields -- do not invent one.

For the resolution chain: reconstruct it ONLY from what the final answer text and retrieved excerpts actually support. For the recommended (winning) carrier, the final answer's Why/Source text should give you enough to reconstruct a real per-condition chain. For every OTHER carrier mentioned in the retrieved excerpts (even though the visible answer never names them), reconstruct whatever chain you can from those excerpts alone. If you don't have enough retrieved text to responsibly reconstruct a carrier's chain, add an entry for it with a single step noting "insufficient retrieved text to reconstruct chain" rather than guessing or leaving it out silently.

For clientNumerics: extract the client's stated height (to total inches), weight (lbs), A1C, and PSA ONLY if explicitly present in the client profile text -- omit any field that wasn't actually stated, never estimate or infer one.

Never invent a page number, quote, or rate class that isn't traceable to the text you were given.`;

const EXTRACT_TOOL = {
  name: "record_structured_recommendation",
  description: "Record the structured, machine-readable form of a just-completed underwriting recommendation, including the per-carrier rule-citation resolution chain.",
  input_schema: {
    type: "object",
    properties: {
      hasRecommendation: { type: "boolean", description: "false if the final answer was a clarifying question or an insufficient-evidence response with no product recommendation." },
      recommendedCarrier: { type: "string", enum: CARRIERS, description: "Carrier id of the recommended product. Omit if hasRecommendation is false." },
      recommendedProduct: { type: "string" },
      rateClass: { type: "string" },
      confidence: { type: "string", enum: ["High", "Medium", "Low"] },
      sourceDocId: { type: "string", description: "Slot id of the specific document the Source line traces to (e.g. 'fe_express')." },
      sourcePage: { type: "number" },
      ruleQuote: { type: "string", description: "The specific guideline text (short quote or close paraphrase) that was the deciding rule." },
      bindingConstraint: { type: "string", description: "The condition/medication/lab value that actually drove the outcome." },
      clientNumerics: {
        type: "object",
        properties: {
          heightIn: { type: "number", description: "Client height in total inches, only if explicitly stated." },
          weightLbs: { type: "number" },
          a1c: { type: "number" },
          psa: { type: "number" },
        },
      },
      chain: {
        type: "array",
        description: "One entry per carrier that had retrieved guidance available, including non-winning carriers.",
        items: {
          type: "object",
          properties: {
            carrier: { type: "string", enum: CARRIERS },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  clientDataPoint: { type: "string" },
                  guidelineQuote: { type: "string" },
                  sourceDocId: { type: "string" },
                  sourcePage: { type: "number" },
                  match: { type: "boolean" },
                  resultingRateClass: { type: "string" },
                },
                required: ["clientDataPoint"],
              },
            },
            carrierConclusion: { type: "string" },
            carrierConfidence: { type: "string" },
          },
          required: ["carrier", "steps"],
        },
      },
    },
    required: ["hasRecommendation"],
  },
};

async function extractStructuredRecommendation(anthropic, { profileText, replyText, narrativeChunks }) {
  const chunkText = (narrativeChunks || [])
    .slice(0, 40)
    .map((m) => `[${CARRIER_NAMES[m.carrier] || m.carrier} — ${m.slot_label || m.slot_id}, p.${m.page_number}]: ${(m.content || "").slice(0, 500)}`)
    .join("\n\n");

  const userText = `CLIENT PROFILE:\n${profileText}\n\nFINAL ANSWER GIVEN TO THE AGENT:\n${replyText}\n\nRETRIEVED GUIDELINE EXCERPTS (narrative search results, may cover carriers beyond the recommended one):\n${chunkText || "(none retrieved)"}`;

  // Deliberately no try/catch here -- a genuine failure (API exception,
  // malformed/missing tool_use, empty response) must propagate to the
  // caller as a thrown error, not collapse into the same "null" this
  // function used to return for it. That collapse is exactly what made a
  // real extraction failure indistinguishable from a legitimate
  // hasRecommendation:false answer (a clarifying question) -- both used to
  // vanish with no record and no signal. The caller now handles the two
  // cases differently: see the fallback record in the handler below.
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 3000,
    system: EXTRACT_SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "record_structured_recommendation" },
    messages: [{ role: "user", content: userText }],
  });
  const toolUse = resp.content.find((b) => b.type === "tool_use" && b.name === "record_structured_recommendation");
  if (!toolUse || !toolUse.input) {
    throw new Error("Extraction call completed but returned no valid record_structured_recommendation tool call.");
  }
  return toolUse.input;
}

// Lightweight numeric cross-check (see _lookup.mjs): never overrides or
// hides the model's own answer, only flags a discrepancy between the rate
// class the model cited and a small, source-grounded lookup table for
// build/BMI (and A1C/PSA where any carrier's ingested documents actually use
// a numeric cutoff for them -- currently none do, see _lookup.mjs).
//
// flaggedForReview stays scoped to the recommended carrier only -- that's
// the one thing actually being submitted, so it's the one worth an urgent
// discrepancy banner. dataGaps is separate and broader: run across every
// carrier that appears in the resolution chain (not just the winner), and
// only for genuine carrier-side gaps (reasonType "no_carrier_data" -- see
// _lookup.mjs) never for the client simply not having provided a value.
// This is what makes "not evaluated" visibly different from "evaluated and
// passed" instead of both looking like silence.
function runNumericCrossCheck(structured) {
  if (!structured?.hasRecommendation) return { flagged: false, checks: [], dataGaps: { winner: null, others: [] } };
  const { recommendedCarrier, rateClass } = structured;
  // Destructuring defaults only cover `undefined`, not other falsy/malformed
  // values -- the extraction tool call has occasionally returned an explicit
  // `chain: null` or a non-object `clientNumerics`, which crashed this whole
  // function (chain.map is not a function) and forced an otherwise-valid,
  // High-confidence recommendation into the extraction_failed fallback path
  // for no reason related to the actual recommendation. Normalize instead of
  // trusting the shape.
  const clientNumerics = (structured.clientNumerics && typeof structured.clientNumerics === "object") ? structured.clientNumerics : {};
  const chain = Array.isArray(structured.chain) ? structured.chain : [];

  const carriersToCheck = new Set([recommendedCarrier, ...chain.map((c) => c?.carrier)].filter(Boolean));
  const gapsByCarrierName = {};
  let winningChecks = [];

  for (const carrier of carriersToCheck) {
    const statedClass = carrier === recommendedCarrier
      ? rateClass
      : chain.find((c) => c.carrier === carrier)?.carrierConclusion;

    const checks = [
      { field: "build", ...crossCheckBuild({ carrier, heightIn: clientNumerics.heightIn, weightLbs: clientNumerics.weightLbs, statedClass }) },
      { field: "a1c", ...crossCheckA1C({ carrier, a1c: clientNumerics.a1c, statedOutcome: statedClass }) },
      { field: "psa", ...crossCheckPSA({ carrier, psa: clientNumerics.psa, statedOutcome: statedClass }) },
    ];

    const gaps = checks.filter((c) => !c.checked && c.reasonType === "no_carrier_data").map((c) => `${c.field}_unavailable`);
    if (gaps.length) gapsByCarrierName[CARRIER_NAMES[carrier] || carrier] = gaps;

    if (carrier === recommendedCarrier) winningChecks = checks;
  }

  // Collapsed for display: only the winning carrier -- the one actually
  // being submitted -- keeps its gaps itemized. Every other carrier's gaps
  // are rolled up by gap type (e.g. one line covering "A1C and PSA also not
  // evaluated for Foresters, Allianz, Transamerica" instead of six separate
  // per-carrier-per-field lines). Same underlying facts, less noise.
  const winnerName = CARRIER_NAMES[recommendedCarrier] || recommendedCarrier || null;
  const winnerGaps = (winnerName && gapsByCarrierName[winnerName]) || [];
  const othersByGapType = {};
  for (const [carrierName, gaps] of Object.entries(gapsByCarrierName)) {
    if (carrierName === winnerName) continue;
    for (const gap of gaps) (othersByGapType[gap] ||= []).push(carrierName);
  }
  const dataGaps = {
    winner: winnerName ? { carrier: winnerName, gaps: winnerGaps } : null,
    others: Object.entries(othersByGapType).map(([gapType, carriers]) => ({ gapType, carriers })),
  };

  const disagreement = winningChecks.find((c) => c.checked && c.agrees === false);
  return {
    flagged: !!disagreement,
    flagReason: disagreement ? `Numeric cross-check disagreement on ${disagreement.field}: ${disagreement.detail}` : null,
    checks: winningChecks,
    dataGaps,
  };
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

  const ctxArgs = { anthropic, supabase, openai, carrierStore, clientStore, convStore, userId, conversationId, message };

  if (debug) {
    const ctx = await buildAnalysisContext(ctxArgs);
    return new Response(JSON.stringify({
      isFollowUp: ctx.isFollowUp, tableStatus: ctx.tableStatus, narrativeStatus: ctx.narrativeStatus, mergedStatus: ctx.mergedStatus,
      carrierSelection: ctx.isFollowUp ? (ctx.record.carrierSelection || {}) : ctx.selectedForRecord,
      tier: ctx.isFollowUp ? (ctx.record.tier || {}) : ctx.tierForRecord,
      narrativeChunks: (ctx.narrativeChunksForRecord || []).map((m) => ({ carrier: m.carrier, slot: m.slot_label || m.slot_id, page: m.page_number, preview: (m.content || "").slice(0, 120) })),
      firstMessageBlockCount: ctx.messages?.[0]?.content?.length ?? null, turnsSoFar: ctx.record.turns.length,
      accessLog: await readAccessLog(userId, conversationId),
      // Cache diagnostics -- raw pre-triage intake extraction + the key it
      // hashed to, so two calls on identical text can be compared directly
      // to see exactly which field (if any) diverged.
      cacheHit: !!ctx.cacheHit, cacheKey: ctx.cacheKey ?? null, intake: ctx.intakeForDebug ?? null,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();
  const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      // Keep the connection alive from the very first byte, not just during
      // the final model call. Triage, document loading, and multi-query
      // research all happen below and can take several seconds on their own
      // -- previously none of that sent a single byte to the client (the
      // Response wasn't even constructed until all of it finished), which
      // is exactly the kind of silent gap an idle-connection proxy timeout
      // kills. Comment-only SSE lines (":...") are inert to the frontend's
      // parser (no "data:" line means it's skipped) but keep bytes flowing.
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* controller may already be closed */ }
      }, 8000);
      const stopHeartbeat = () => clearInterval(heartbeat);

      let ctx;
      try {
        ctx = await buildAnalysisContext(ctxArgs);
      } catch (err) {
        stopHeartbeat();
        controller.enqueue(sse("error", { error: err.message }));
        controller.close();
        return;
      }
      const {
        record, isFollowUp, cacheHit, cacheKey, cachedReplyText, cachedRecommendation,
        tableStatus, narrativeStatus, mergedStatus, messages,
        selectedForRecord, tierForRecord, clientDocKeysForRecord, narrativeChunksForRecord,
      } = ctx;

      if (!isFollowUp) controller.enqueue(sse("meta", { carrierStatus: mergedStatus }));
      let replyText = "";

      if (cacheHit) {
        // Consistency cache hit: identical structured client intake AND an
        // identical guideline-version hash as a prior run. Replay the exact
        // same answer instead of re-running triage/research/final-analysis
        // (the stage that actually varies run to run) -- this is the whole
        // point, not just caching the output after the fact.
        replyText = cachedReplyText || "";
        if (!replyText) {
          stopHeartbeat();
          controller.enqueue(sse("error", { error: "Cached entry had no answer text. Try again." }));
          controller.close();
          return;
        }
        const CHUNK = 200;
        for (let i = 0; i < replyText.length; i += CHUNK) {
          controller.enqueue(sse("delta", { text: replyText.slice(i, i + CHUNK) }));
        }
      } else {
        try {
          // Thinking disabled: Netlify's function timeout leaves no room for
          // adaptive thinking's invisible reasoning phase on top of native PDF
          // processing -- see chat.mjs history for the earlier 60s timeout fix.
          // NOTE: `temperature` is deprecated/rejected outright by claude-sonnet-5
          // (confirmed via a live 400 "temperature is deprecated for this model")
          // -- there is currently no sampling-temperature knob for this model, so
          // determinism instead relies on thinking being disabled and the
          // documents/system prompt being the same on every call for a given
          // client, not an explicit temperature setting. Run-to-run variance
          // this call and the research stage before it can still introduce is
          // what the consistency cache above is for -- it doesn't make this
          // call itself more deterministic, it just avoids re-running it (and
          // everything before it) for input already seen once.
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
            stopHeartbeat();
            controller.enqueue(sse("error", { error: `Model returned no text (stop_reason: ${stopReason}). Try again or narrow the client profile.` }));
            controller.close();
            return;
          }
        } catch (err) {
          stopHeartbeat();
          controller.enqueue(sse("error", { error: err.message }));
          controller.close();
          return;
        }
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

      // Structured recommendation record: a second, cheap tool-forced
      // extraction pass (see extractStructuredRecommendation) reads back the
      // already-completed answer and produces schema-valid structured data,
      // then the numeric cross-check runs against it. Heartbeat stays alive
      // through this -- it's a real network call, and staying silent here
      // would reopen the same idle-timeout risk the earlier restructure
      // fixed, even though the user's visible answer has already fully
      // streamed by this point.
      let recommendationInfo = null;

      if (cacheHit) {
        // Copy the cached structured record forward as THIS conversation's
        // own recommendation entry -- every conversation still gets its own
        // audit-trail record (per-conversation immutability is unaffected),
        // it just doesn't re-run extraction/cross-check, since by definition
        // of a cache hit the inputs (and therefore the correct output) are
        // identical to the run that produced the cached entry.
        if (cachedRecommendation) {
          try {
            const saved = await saveRecommendation({
              ...cachedRecommendation,
              userId, conversationId, timestamp: now, status: "ok", servedFromCache: true, cacheKey,
              agentReviewed: false, agentAgreed: null,
            });
            recommendationInfo = {
              key: saved.key, flaggedForReview: saved.flaggedForReview, flagReason: saved.flagReason,
              recordSaved: true, status: "ok", servedFromCache: true,
              dataGaps: saved.dataGaps || {},
            };
          } catch { /* best-effort -- the cached reply already reached the agent */ }
        }
      } else {
        let structured = null;
        try {
          const profileTextForExtraction = isFollowUp ? `${record.profileText}\n\nFollow-up: ${message}` : message;

          // extractStructuredRecommendation now throws on a genuine failure
          // (API exception, malformed/missing tool_use) instead of returning
          // null for it -- null used to mean the exact same thing as a
          // legitimate hasRecommendation:false answer (a clarifying question),
          // so a real failure and "nothing to record" were indistinguishable
          // and both vanished with no trace. Caught here, separately, so a
          // real failure gets its own minimal fallback record and a flag the
          // agent can actually see, instead of silently looking identical to
          // a normal turn that just didn't need a recommendation.
          try {
            structured = await extractStructuredRecommendation(anthropic, {
              profileText: profileTextForExtraction, replyText, narrativeChunks: narrativeChunksForRecord,
            });
          } catch (extractErr) {
            await logAccess(userId, conversationId, "recommendation_extraction_failed");
            const saved = await saveRecommendation({
              userId, conversationId, timestamp: now, status: "extraction_failed",
              errorMessage: extractErr.message, rawAnswerText: replyText,
            });
            recommendationInfo = { key: saved.key, recordSaved: false, status: "extraction_failed" };
            structured = null;
          }

          if (structured?.hasRecommendation) {
            const crossCheck = runNumericCrossCheck(structured);
            const recordFields = {
              recommendedCarrier: structured.recommendedCarrier || null,
              recommendedProduct: structured.recommendedProduct || null,
              rateClass: structured.rateClass || null,
              confidence: structured.confidence || null,
              sourceDocId: structured.sourceDocId || null,
              sourcePage: structured.sourcePage ?? null,
              ruleQuote: structured.ruleQuote || null,
              bindingConstraint: structured.bindingConstraint || null,
              clientNumerics: structured.clientNumerics || {},
              chain: structured.chain || [],
              flaggedForReview: crossCheck.flagged,
              flagReason: crossCheck.flagReason,
              numericChecks: crossCheck.checks,
              dataGaps: crossCheck.dataGaps || {},
            };
            const saved = await saveRecommendation({
              userId, conversationId, timestamp: now, status: "ok",
              ...recordFields, agentReviewed: false, agentAgreed: null,
            });
            recommendationInfo = {
              key: saved.key, flaggedForReview: saved.flaggedForReview, flagReason: saved.flagReason,
              recordSaved: true, status: "ok", dataGaps: saved.dataGaps || {},
            };

            // Populate the consistency cache -- only on a clean, successfully
            // extracted result, only if intake extraction earlier succeeded
            // enough to produce a cacheKey at all, AND only at High
            // confidence. A cached wrong answer repeats indefinitely instead
            // of being a one-off -- acceptable when the model itself is
            // confident the guideline text resolves cleanly, not acceptable
            // for a Medium/Low case where the model is already signaling
            // some interpretation gap. Those always re-run the full pipeline,
            // every time, even for the exact same input.
            if (cacheKey && structured.confidence === "High") {
              await saveCachedRecommendation(cacheKey, {
                replyText, recommendation: recordFields,
                tableStatus, narrativeStatus, mergedStatus,
                carrierSelection: selectedForRecord, tier: tierForRecord,
                narrativeChunks: narrativeChunksForRecord,
              });
            }
          } else if (structured && cacheKey) {
            // A legitimate no-recommendation answer (a clarifying question)
            // is exactly the kind of output that should ALSO be consistent
            // run to run -- cache the reply text even without a structured
            // recommendation to go with it.
            await saveCachedRecommendation(cacheKey, {
              replyText, recommendation: null,
              tableStatus, narrativeStatus, mergedStatus,
              carrierSelection: selectedForRecord, tier: tierForRecord,
              narrativeChunks: narrativeChunksForRecord,
            });
          }
        } catch (pipelineErr) {
          // A failure OUTSIDE extraction itself -- e.g. saveRecommendation's
          // own Blobs write failing after a successful extraction. Rarer, but
          // the same class of silent gap if swallowed, so it gets the same
          // treatment: logged through the existing access-log mechanism, and
          // a best-effort fallback record (raw answer text at minimum).
          await logAccess(userId, conversationId, "recommendation_persist_failed");
          try {
            const saved = await saveRecommendation({
              userId, conversationId, timestamp: now, status: "extraction_failed",
              errorMessage: pipelineErr.message, rawAnswerText: replyText,
            });
            recommendationInfo = { key: saved.key, recordSaved: false, status: "extraction_failed" };
          } catch { /* persistence itself is down -- the agent's reply still isn't blocked, but truly nothing more to log here */ }
        }
      }

      stopHeartbeat();
      if (recommendationInfo) controller.enqueue(sse("recommendation", recommendationInfo));

      if (!isFollowUp) {
        record.profileText = message;
        record.carrierSelection = selectedForRecord;
        record.tier = tierForRecord;
        record.tableStatus = tableStatus;
        record.clientDocKeys = clientDocKeysForRecord;
        record.turns.push({ role: "assistant", text: replyText, recommendation: recommendationInfo });
        if (!record.label) record.label = deriveLabel(record.profileText, replyText);
      } else {
        record.turns.push({ role: "user", text: message });
        record.turns.push({ role: "assistant", text: replyText, recommendation: recommendationInfo });
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
