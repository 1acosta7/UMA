import { CORS, jsonError, requirePlatformAdmin, getClerkClient } from "./_shared.mjs";

// Org provisioning is platform-admin-only (see requirePlatformAdmin) now
// that self-serve creation has been removed from the agent-facing Settings
// panel -- agencies are stood up here instead. createdBy makes the platform
// admin the new org's own admin, which is deliberate: it's the only way our
// existing UI (the OrganizationSwitcher/OrganizationProfile already mounted
// in Settings) can be used to invite the agency's real first admin without
// building a separate invite flow. The intended handoff is create -> invite
// the real admin from Settings -> leave the org once they've accepted.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let ctx;
  try {
    ctx = await requirePlatformAdmin(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { name } = await req.json().catch(() => ({}));
  if (!name || !name.trim()) return jsonError(400, "Organization name is required");

  try {
    const org = await getClerkClient().organizations.createOrganization({
      name: name.trim(),
      createdBy: ctx.userId,
    });
    return new Response(JSON.stringify({ id: org.id, name: org.name, slug: org.slug }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonError(500, `Could not create organization: ${err.message}`);
  }
}
