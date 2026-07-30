import { getStore } from "@netlify/blobs";
import { CORS } from "./_shared.mjs";

// Serves a single rasterized PDF-page PNG from the `guideline-page-images`
// store by key, for the clickable source-page links added to
// UNDERWRITING_KNOWLEDGE_BASE.md in Phase 2. Deliberately unauthenticated
// (unlike almost every other endpoint in this app) so a plain markdown link
// actually resolves when clicked -- Clerk's browser-side bearer token can't
// be attached to an ordinary link click/navigation, and this app's
// requireUser() only checks the Authorization header, not a session cookie.
// This is an accepted, disclosed tradeoff: the content served is carrier
// agent-guide PDF pages (producer-facing product literature, not client
// data or credentials), keys are structured but not trivially enumerable,
// and this endpoint is not linked from anywhere in the live app UI -- only
// from the standalone knowledge-base markdown file. If tighter access is
// ever needed, add a shared query-secret check here.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key) return new Response("key query param is required", { status: 400, headers: CORS });

  const store = getStore({ name: "guideline-page-images", consistency: "strong" });
  const bytes = await store.get(key, { type: "arrayBuffer" });
  if (!bytes) return new Response("Not found", { status: 404, headers: CORS });

  return new Response(bytes, {
    status: 200,
    headers: { ...CORS, "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
