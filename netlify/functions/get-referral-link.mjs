import { CORS, jsonError, requireUserContext, getOrCreateReferralCode } from "./_shared.mjs";

// Every agent gets a code, not just org:admins or existing team leads --
// "has a team" is the eventual state this builds toward, not a
// precondition. No org active -> no code (there's nothing to join them
// into), same as every other org-scoped section in this app.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonError(405, "Method not allowed");

  let ctx;
  try {
    ctx = await requireUserContext(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  if (!ctx.orgId) {
    return new Response(JSON.stringify({ code: null }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const code = await getOrCreateReferralCode(ctx.orgId, ctx.userId);
  return new Response(JSON.stringify({ code }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
