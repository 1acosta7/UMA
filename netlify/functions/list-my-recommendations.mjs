import { CORS, jsonError, requireUser, listRecentRecommendationsForUser } from "./_shared.mjs";

// Powers the Settings-panel activity view -- the agent's own recent
// recommendation records across every client, not one conversation's. Same
// ownership model as everything else: listRecentRecommendationsForUser keys
// strictly off this caller's own userId, so there's no way to request
// another agent's activity through this endpoint.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const recommendations = (await listRecentRecommendationsForUser(userId))
    .map((r) => ({ ...r, status: r.status || "ok" }));
  return new Response(JSON.stringify({ recommendations }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
