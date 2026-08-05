import { CORS, jsonError, requireUserContext, getClerkClient, resolveReferralCode, upsertOrgMember } from "./_shared.mjs";

// Called once, right after a brand-new (or existing) agent signs in through
// a referral link -- see login.html for where the code is captured and
// app.html for where this gets called. Joining the org here goes through
// Clerk's backend API directly (authenticated with our own secret key, not
// the referring agent's own permissions), which is why this can work for
// ANY agent's link, not just an org:admin's -- Clerk's own org:admin-only
// invite restriction lives in its frontend components, not in the backend
// API itself, so our own endpoint is free to allow this on purpose.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let ctx;
  try {
    ctx = await requireUserContext(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { code } = await req.json().catch(() => ({}));
  if (!code) return jsonError(400, "code is required");

  const referral = await resolveReferralCode(code);
  if (!referral) return jsonError(404, "Invalid or expired referral link");
  if (referral.referringUserId === ctx.userId) return jsonError(400, "You can't use your own referral link");

  try {
    await getClerkClient().organizations.createOrganizationMembership({
      organizationId: referral.orgId,
      userId: ctx.userId,
      role: "org:member",
    });
  } catch (err) {
    // Already being a member of this org is fine -- we still want to set
    // reportsTo below. Anything else (bad org, Clerk API failure) is real.
    if (!/already|duplicate|exist/i.test(err.message || "")) {
      return jsonError(500, `Could not join organization: ${err.message}`);
    }
  }

  const record = await upsertOrgMember(referral.orgId, ctx.userId, { reportsTo: referral.referringUserId });
  return new Response(JSON.stringify({ orgId: referral.orgId, reportsTo: record.reportsTo }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
