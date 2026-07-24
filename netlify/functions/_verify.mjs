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

  const results = [];
  for (const key of blobKeys) {
    const underscoreIdx = key.indexOf("_");
    const carrier = key.slice(0, underscoreIdx);
    const slotId = key.slice(underscoreIdx + 1);
    const status = statusByKey.get(key);
    const actualChunks = actualCounts.get(key) || 0;

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
      state,
    });
  }

  // Orphaned: tracked/searchable under a carrier_slotId with no corresponding
  // upload anymore (e.g. the PDF was deleted but cleanup didn't fully run).
  // A missing blob is NOT orphaned when ingestion_status shows table_page_count
  // === 0 -- that's a 100%-narrative document, and _ingest.mjs intentionally
  // deletes the carrier-docs blob for those since there's no table content
  // worth keeping natively. That status row is proof of a correct, intentional
  // absence, not a data-integrity gap.
  const blobKeySet = new Set(blobKeys);
  const orphanedKeys = new Set();
  for (const key of actualCounts.keys()) {
    if (blobKeySet.has(key)) continue;
    const status = statusByKey.get(key);
    if (status && status.table_page_count === 0) continue;
    orphanedKeys.add(key);
  }
  for (const row of statusRows) {
    const key = `${row.carrier}_${row.slot_id}`;
    if (blobKeySet.has(key)) continue;
    if (row.table_page_count === 0) continue;
    orphanedKeys.add(key);
  }

  const problems = results.filter((r) => r.state !== "ok");
  return {
    ok: problems.length === 0 && orphanedKeys.size === 0,
    totalDocuments: results.length,
    okCount: results.length - problems.length,
    documents: results,
    problems,
    orphaned: [...orphanedKeys],
    checkedAt: new Date().toISOString(),
  };
}
