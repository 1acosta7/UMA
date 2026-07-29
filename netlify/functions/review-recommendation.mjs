import { CORS, jsonError, requireUser, updateRecommendationReview, logAccess } from "./_shared.mjs";

// Shadow-mode validation logging: an agent marking whether they later
// learned the real carrier outcome, and whether it matched what UMA said.
// There's no pre-existing labeled-outcome dataset for this pipeline -- this
// is how one gets built up over time instead of requiring one up front.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { conversationId, key, agentAgreed, notes } = await req.json();
  if (!conversationId || !key) return jsonError(400, "conversationId and key are required");

  try {
    const updated = await updateRecommendationReview(userId, conversationId, key, {
      agentReviewed: true,
      agentAgreed: agentAgreed === undefined ? null : agentAgreed,
      notes,
    });
    await logAccess(userId, conversationId, "recommendation_reviewed");
    return new Response(JSON.stringify({ success: true, recommendation: updated }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonError(400, err.message);
  }
}
