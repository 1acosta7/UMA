import { CORS, jsonError, requireUserContext, upsertOrgMember } from "./_shared.mjs";

// Clerk owns the real org/membership objects; this endpoint just mirrors the
// currently-active org (if any) into our own org-members store so a future
// admin dashboard has a materialized, listable view of seats per org without
// standing up a Clerk webhook. Called from the frontend on load and whenever
// the org switcher changes -- safe to call with no active org (agent not in
// any organization, or "membership optional" and none selected): it's just a
// no-op, not an error, since that's the normal state for every existing
// solo agent.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let ctx;
  try {
    ctx = await requireUserContext(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  if (!ctx.orgId) {
    return new Response(JSON.stringify({ orgId: null }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const member = await upsertOrgMember(ctx.orgId, ctx.userId, { role: ctx.orgRole || "org:member" });
  return new Response(JSON.stringify({ orgId: ctx.orgId, role: member.role }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
