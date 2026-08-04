import { CORS, jsonError, requireUserContext, loadOrgMember, upsertOrgMember } from "./_shared.mjs";

// Assigning who reports to whom is org:admin-only, scoped strictly to the
// caller's own currently-active org -- deliberately checked against
// ctx.orgRole/ctx.orgId from the verified token, never a client-supplied
// orgId, so an org:admin of one agency can't touch another agency's
// reporting lines. This is a separate action from inviting someone into the
// org (still Clerk's own OrganizationProfile UI) -- it only ever repoints
// an existing member's reportsTo field on the org-members record.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let ctx;
  try {
    ctx = await requireUserContext(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  if (!ctx.orgId || ctx.orgRole !== "org:admin") return jsonError(403, "Org admin access required");

  const { targetUserId, reportsTo } = await req.json().catch(() => ({}));
  if (!targetUserId) return jsonError(400, "targetUserId is required");
  if (reportsTo && reportsTo === targetUserId) return jsonError(400, "An agent can't report to themselves");

  const target = await loadOrgMember(ctx.orgId, targetUserId);
  if (!target) return jsonError(404, "targetUserId is not a member of your organization");

  if (reportsTo) {
    const manager = await loadOrgMember(ctx.orgId, reportsTo);
    if (!manager) return jsonError(404, "reportsTo is not a member of your organization");
  }

  const record = await upsertOrgMember(ctx.orgId, targetUserId, { reportsTo: reportsTo || null });
  return new Response(JSON.stringify({ userId: record.userId, reportsTo: record.reportsTo }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
