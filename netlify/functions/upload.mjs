import { SLOT_LABELS } from "./_shared.mjs";
import { ingestCarrierDoc } from "./_ingest.mjs";
import { runVerification } from "./_verify.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { pin, carrier, slotId, data, filename } = await req.json();

  if (!pin || pin !== Netlify.env.get("ADMIN_PIN")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (!carrier || !slotId || !data) {
    return new Response(JSON.stringify({ error: "carrier, slotId, and data are required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const buf = Buffer.from(data, "base64");
  if (buf.byteLength > 4.5 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: "File exceeds 4.5 MB limit" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") {
    return new Response(JSON.stringify({ error: "File does not appear to be a PDF" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const key = `${carrier}_${slotId}`;
  const slotLabel = SLOT_LABELS[carrier]?.[slotId] || slotId;

  // Hybrid ingestion: classify every page as table-heavy or narrative.
  // Table-heavy content is stored under this same key as a native PDF (see
  // _ingest.mjs for how it decides between the full document and a sliced
  // table-pages-only PDF) so chat.mjs's existing document-block logic reads
  // it exactly like before -- no changes needed there. Narrative content is
  // chunked, embedded, and stored in Supabase/pgvector for retrieval at
  // query time instead of being sent as part of a native PDF block.
  let ingestResult;
  try {
    ingestResult = await ingestCarrierDoc({ carrier, slotId, slotLabel, filename, buf });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Ingestion failed: ${err.message}` }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Run the same verification check every time a file is added, not just on
  // demand -- catches an indexing gap immediately rather than leaving it to
  // be discovered later at query time.
  let verification = null;
  try {
    verification = await runVerification();
  } catch { /* verification failing shouldn't mask that the upload itself succeeded */ }

  return new Response(JSON.stringify({
    success: true,
    key,
    classification: ingestResult.report,
    tablePageCount: ingestResult.tablePageCount,
    narrativePageCount: ingestResult.narrativePageCount,
    chunkCount: ingestResult.chunkCount,
    narrativeError: ingestResult.narrativeError,
    verification,
  }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
