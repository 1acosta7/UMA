import { getStore } from "@netlify/blobs";
import { createClient } from "@supabase/supabase-js";
import { SLOT_LABELS } from "./_shared.mjs";

// Cross-references three things that should always agree and, left
// unchecked, can silently drift apart:
//   1. carrier-docs Blobs  -- what's actually uploaded (the real source of
//      truth for "what should be indexed"; there is no live-synced local
//      folder in this architecture, this Blobs store IS the folder)
//   2. ingestion_status     -- what the last ingestion run recorded for
//      each uploaded document (page counts, chunk count, any error)
//   3. guideline_chunks     -- what's actually searchable right now
//
// A document can look "fine" (uploaded, has a tablePageCount) while quietly
// having zero of the narrative chunks its own ingestion run claimed to
// produce, if something failed between recording the count and the insert
// actually landing. This is what catches that.
export async function runVerification() {
  const carrierStore = getStore({ name: "carrier-docs", consistency: "strong" });
  const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_KEY"));

  let blobKeys = [];
  try {
    const { blobs } = await carrierStore.list();
    blobKeys = blobs.map((b) => b.key);
  } catch { /* carrier-docs store empty or unavailable */ }

  let statusRows = [];
  try {
    const { data, error } = await supabase.from("ingestion_status").select("*");
    if (error) throw new Error(error.message);
    statusRows = data || [];
  } catch (err) {
    return { ok: false, error: `Could not read ingestion_status: ${err.message}`, checkedAt: new Date().toISOString() };
  }
  const statusByKey = new Map(statusRows.map((r) => [`${r.carrier}_${r.slot_id}`, r]));

  let actualCounts = new Map();
  try {
    const { data, error } = await supabase.from("guideline_chunks").select("carrier, slot_id");
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      const key = `${row.carrier}_${row.slot_id}`;
      actualCounts.set(key, (actualCounts.get(key) || 0) + 1);
    }
  } catch (err) {
    return { ok: false, error: `Could not read guideline_chunks: ${err.message}`, checkedAt: new Date().toISOString() };
  }

  // Every carrier_slotId that's tracked anywhere -- has a native PDF blob,
  // an ingestion_status row, or searchable chunks -- must appear in the
  // report. Iterating blobKeys alone silently drops 100%-narrative documents
  // (which correctly have no blob) from totalDocuments/okCount entirely,
  // rather than just from the orphan check: a doc iterated by blobKeys is
  // the only way it every reaches `results`, so those documents were never
  // being verified as "ok" -- they just weren't being reported on at all.
  const allKeys = new Set([...blobKeys, ...statusByKey.keys(), ...actualCounts.keys()]);

  const results = [];
  for (const key of allKeys) {
    const underscoreIdx = key.indexOf("_");
    const carrier = key.slice(0, underscoreIdx);
    const slotId = key.slice(underscoreIdx + 1);
    const status = statusByKey.get(key);
    const actualChunks = actualCounts.get(key) || 0;
    const hasBlob = blobKeys.includes(key);

    let state;
    if (!status) {
      state = "needs_reindex"; // uploaded before this tracking existed, or status write failed
    } else if (status.narrative_error) {
      state = "failed";
    } else if (status.table_page_count === 0 && status.narrative_page_count === 0) {
      state = "failed"; // nothing classified at all -- likely unreadable/corrupt PDF
    } else if (status.narrative_page_count > 0 && actualChunks === 0) {
      state = "missing_chunks"; // claimed narrative content, nothing searchable
    } else if (status.chunk_count !== actualChunks) {
      state = "count_mismatch"; // recorded count and actual stored count disagree
    } else if (status.table_page_count > 0 && !hasBlob) {
      state = "missing_blob"; // claimed table content, no native PDF block to show for it
    } else {
      state = "ok";
    }

    results.push({
      key, carrier, slotId,
      slotLabel: SLOT_LABELS[carrier]?.[slotId] || slotId,
      sourceFilename: status?.source_filename || null,
      tablePageCount: status?.table_page_count ?? null,
      narrativePageCount: status?.narrative_page_count ?? null,
      recordedChunkCount: status?.chunk_count ?? null,
      actualChunkCount: actualChunks,
      hasNativeBlob: hasBlob,
      pageReport: status?.page_report ?? null,
      state,
    });
  }

  // "orphaned" is kept as a field (rather than removed) for the build
  // plugin/UI, which already read it -- now just the missing_blob subset of
  // `problems`, computed once instead of by a second, separately-maintained
  // pass over the same three data sources.
  const problems = results.filter((r) => r.state !== "ok");
  const orphaned = results.filter((r) => r.state === "missing_blob").map((r) => r.key);
  return {
    ok: problems.length === 0,
    totalDocuments: results.length,
    okCount: results.length - problems.length,
    documents: results,
    problems,
    orphaned,
    checkedAt: new Date().toISOString(),
  };
}
