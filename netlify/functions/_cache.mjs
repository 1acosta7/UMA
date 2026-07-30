import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// Consistency fix, not a determinism trick on the model: the actual source
// of run-to-run variance is the research stage (claude-haiku-4-5 improvising
// which/how many searches to run per carrier), which then changes what the
// final model sees. There's no temperature knob on claude-sonnet-5 to force
// determinism directly (confirmed via a live 400 earlier in this project).
// Instead: cache the finished result of the whole triage/research/final-
// analysis pipeline, keyed on the client's structured intake + a hash of
// which guideline documents are currently ingested, so identical input
// deterministically returns the identical prior answer instead of re-running
// a pipeline that's allowed to vary internally.
//
// Global, not per-agent -- EXCEPT for licensed-carrier scope (Phase 3): two
// agents with the SAME licensed carriers submitting the literal same client
// facts should get the literal same underwriting answer, that's still a
// correctness property of the guidelines. But an agent licensed for only 2
// of the 4 carriers must never be served a cached answer that was generated
// (and may have won) on a carrier they can't actually sell -- the recommended
// carrier is part of what's "correct" here, and that now genuinely depends
// on who's asking. licensedCarriers is folded into the cache key below for
// exactly this reason: different licensing scopes never collide on the same
// entry, even for byte-identical client facts. Cached entries otherwise still
// contain only structured medical/financial facts and the resulting
// recommendation text, nothing about which specific agent or client
// submitted it.

// One combined hash over every carrier's ingestion state, not a hash per
// carrier -- a recommendation compares across all four carriers together,
// so a change to ANY carrier's ingested documents can change which carrier
// wins, and must invalidate every cache entry, not just that carrier's.
export async function computeGuidelineVersionHash(supabase) {
  if (!supabase) return "no-supabase";
  try {
    const { data, error } = await supabase
      .from("ingestion_status")
      .select("carrier, slot_id, ingested_at, chunk_count, table_page_count")
      .order("carrier", { ascending: true })
      .order("slot_id", { ascending: true });
    if (error) throw new Error(error.message);
    const canonical = (data || [])
      .map((r) => `${r.carrier}|${r.slot_id}|${r.ingested_at}|${r.chunk_count}|${r.table_page_count}`)
      .join("\n");
    return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  } catch {
    // Can't determine ingestion state -- fail toward NOT caching rather than
    // caching under a wrong/stale version. A unique-per-call hash guarantees
    // every lookup against this hash misses, degrading to "always run the
    // full pipeline" instead of ever serving a possibly-stale cached answer.
    return `unavailable-${crypto.randomUUID()}`;
  }
}

// Light, safe text normalization -- collapses punctuation/whitespace/case
// variance a model might introduce even when it's otherwise transcribing
// consistently (extra comma, parenthesis, trailing period). Deliberately
// NOT aggressive: no synonym mapping, no stemming, no filler-word list
// beyond a single leading article -- the real fix for semantic paraphrasing
// (different word choice for the same fact) is the tightened extraction
// prompt in chat.mjs (INTAKE_SYSTEM/INTAKE_TOOL), which constrains the
// model to a consistent canonical form in the first place. This is defense
// in depth for the mechanical noise a prompt can't fully eliminate, not a
// substitute for getting the extraction itself consistent.
function normText(s) {
  if (typeof s !== "string") return s;
  return s
    .toLowerCase()
    .replace(/[().,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(a|an|the)\s+/, "");
}

// Despite a schema declaring `type: "array"`, the extraction call has
// occasionally returned a JSON-stringified array for a nested field instead
// of an actual array (a tool-call serialization quirk on complex nested
// structures under this model, not a wording/paraphrasing issue -- caught
// live via the debug-mode intake diff while verifying the wording fix
// below). Two identical inputs producing "real array" vs "array serialized
// as a string" would otherwise hash differently even with identical
// content. Parse-if-string before anything else so this can never be a
// source of a spurious cache miss.
function coerceToArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// diagnoses now come as {condition, modifiers} objects (see INTAKE_TOOL) so
// the qualifying detail that varied most between runs -- "no neuropathy",
// "on insulin", severity, control status -- is captured as short atomic
// phrases in a required canonical form, rather than folded into one
// freeform clause the model rephrased differently each time. Modifiers are
// sorted within each diagnosis, and diagnoses are sorted by condition name,
// so word ORDER is never a source of variance regardless of what order the
// model happened to list things in. Still accepts a plain string per entry
// (treated as {condition: string, modifiers: []}) for robustness against an
// older-shaped extraction result.
function normDiagnoses(rawArr) {
  const arr = coerceToArray(rawArr);
  return arr
    .map((d) => {
      if (typeof d === "string") return { condition: normText(d), modifiers: [] };
      const condition = normText(d?.condition);
      const modifiers = coerceToArray(d?.modifiers).map(normText).filter(Boolean).sort();
      return { condition, modifiers };
    })
    .filter((d) => d.condition)
    .sort((a, b) => a.condition.localeCompare(b.condition));
}

// Deliberately conservative: exact match on every structured field, no
// fuzzy/approximate matching, no rounding of stated values. Two clients
// differing in ANY field -- including a medication or diagnosis phrased
// differently enough to survive normText -- get different keys and never
// collide. Missing fields are represented as null (not omitted), so "field
// present but empty" and "field never asked about" can't accidentally hash
// the same.
export function buildIntakeCacheKey(intake, versionHash, licensedCarriers) {
  const norm = normText;
  const normList = (arr) => coerceToArray(arr).map(norm).filter(Boolean).sort();

  // Fixed key order -- this IS the canonicalization, no generic object-key
  // sorter needed since every field is spelled out explicitly here.
  const canonical = JSON.stringify({
    age: intake?.age ?? null,
    sex: norm(intake?.sex) ?? null,
    heightIn: intake?.heightIn ?? null,
    weightLbs: intake?.weightLbs ?? null,
    tobacco: norm(intake?.tobacco) ?? null,
    medications: normList(intake?.medications),
    diagnoses: normDiagnoses(intake?.diagnoses),
    coverageAmount: intake?.coverageAmount ?? null,
    productObjective: norm(intake?.productObjective) ?? null,
    guidelineVersionHash: versionHash,
    // Sorted so licensing order never matters, only the actual set does.
    licensedCarriers: [...new Set(licensedCarriers || [])].sort(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export async function getCachedRecommendation(cacheKey) {
  const store = getStore({ name: "recommendation-cache", consistency: "strong" });
  try {
    const text = await store.get(cacheKey, { type: "text" });
    return text ? JSON.parse(text) : null;
  } catch {
    return null; // cache read failing must degrade to "run the pipeline," never crash
  }
}

export async function saveCachedRecommendation(cacheKey, entry) {
  const store = getStore({ name: "recommendation-cache", consistency: "strong" });
  try {
    await store.set(cacheKey, JSON.stringify({ ...entry, cachedAt: new Date().toISOString() }));
  } catch { /* cache write failing must never block the reply the agent already received */ }
}
