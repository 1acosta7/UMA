import { getStore } from "@netlify/blobs";
import { CORS, jsonError, requirePlatformAdmin } from "./_shared.mjs";
import { runVerification } from "./_verify.mjs";

// Reuses runVerification() directly (the same function verify-index.mjs
// calls) rather than making an HTTP round-trip to that endpoint -- it's
// intentionally PIN-only with no Clerk auth so Netlify's post-deploy build
// plugin can call it with no session available, and this endpoint shouldn't
// need to know its PIN just to show the same report through a real
// Clerk-authed path.
async function countBlobs(storeName) {
  try {
    const { blobs } = await getStore({ name: storeName, consistency: "strong" }).list();
    return blobs.length;
  } catch {
    return null;
  }
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonError(405, "Method not allowed");

  try {
    await requirePlatformAdmin(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const [verification, conversations, clientProfiles, recommendations, agents] = await Promise.all([
    runVerification().catch((err) => ({ ok: false, error: err.message })),
    countBlobs("conversations"),
    countBlobs("client-profiles"),
    countBlobs("recommendations"),
    countBlobs("user-settings"),
  ]);

  return new Response(JSON.stringify({
    verification,
    counts: { conversations, clientProfiles, recommendations, agents },
    checkedAt: new Date().toISOString(),
  }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
