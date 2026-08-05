import { CORS, jsonError, requireUserContext, loadOrgMember, upsertOrgMember } from "./_shared.mjs";

// Walks UP the proposed manager's own reportsTo chain -- if targetUserId
// shows up in it, assigning targetUserId -> proposedManagerId would close a
// loop (e.g. A already reports to B, and this call tries to set B reports
// to A). Now that My Team shows full multi-level downlines, a cycle
// wouldn't just look wrong, it'd never terminate without the BFS's own
// visited-set guard silently dropping part of the tree -- better to refuse
// creating one than rely on that guard to paper over it.
async function wouldCreateCycle(orgId, targetUserId, proposedManagerId) {
  let current = proposedManagerId;
  const seen = new Set();
  while (current) {
    if (current === targetUserId) return true;
    if (seen.has(current)) return false; // pre-existing cycle upstream, not this call's problem
    seen.add(current);
    const m = await loadOrgMember(orgId, current);
    current = m?.reportsTo || null;
  }
  return false;
}

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
    if (await wouldCreateCycle(ctx.orgId, targetUserId, reportsTo)) {
      return jsonError(400, "That would create a reporting cycle");
    }
  }

  const record = await upsertOrgMember(ctx.orgId, targetUserId, { reportsTo: reportsTo || null });
  return new Response(JSON.stringify({ userId: record.userId, reportsTo: record.reportsTo }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
