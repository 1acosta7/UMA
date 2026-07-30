import { getStore } from "@netlify/blobs";
import { CORS, jsonError, requireUser } from "./_shared.mjs";

// Phase 2 (visual source references) batch-upload endpoint. Writes rendered
// PDF-page PNGs into the `guideline-page-images` Blobs store, keyed
// `${carrier}_${filename}_page${n}` -- a static, one-time training-tool
// artifact for UNDERWRITING_KNOWLEDGE_BASE.md. Explicitly NOT part of the
// live agent-facing recommendation flow: chat.mjs never imports this store,
// and this endpoint is only ever called from the local batch-rasterization
// script driven through the logged-in Setup session, never per-query.
//
// Auth is ordinary Clerk requireUser (same bar as upload-client-doc.mjs),
// not the admin PIN -- this is purely additive (new keys in a brand-new
// store) and touches no existing user data, unlike backfill-client-profiles.mjs's
// bulk mutation of real records, which is why that one is PIN-gated and this
// one isn't.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  try {
    await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { images } = await req.json();
  if (!Array.isArray(images) || images.length === 0) {
    return jsonError(400, "images (non-empty array of {key, imageBase64}) is required");
  }

  const store = getStore({ name: "guideline-page-images", consistency: "strong" });
  const results = [];
  for (const img of images) {
    const { key, imageBase64 } = img || {};
    if (!key || !imageBase64) {
      results.push({ key: key || null, ok: false, error: "missing key or imageBase64" });
      continue;
    }
    try {
      const bytes = Buffer.from(imageBase64, "base64");
      await store.set(key, bytes, { metadata: { contentType: "image/png", bytes: bytes.length } });
      results.push({ key, ok: true, bytes: bytes.length });
    } catch (err) {
      results.push({ key, ok: false, error: err.message });
    }
  }

  return new Response(JSON.stringify({ results }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
