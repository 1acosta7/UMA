import { CORS, jsonError, requireUser, listRecommendations } from "./_shared.mjs";

// Lets the frontend load flag/review state for a conversation's
// recommendation records without them needing to be re-derived from turn
// text -- used to render the "flagged for review" badge and the thumbs-up/
// down control on reopening a thread, not just right after it streams.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { conversationId } = await req.json();
  if (!conversationId) return jsonError(400, "conversationId is required");

  const recommendations = await listRecommendations(userId, conversationId);
  return new Response(JSON.stringify({ recommendations }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
