import {
  CORS, jsonError, requirePlatformAdmin, getClerkClient,
  listAllUserSettings, listAllOrgMembers, getLastSeenAt,
} from "./_shared.mjs";

// Admin-dashboard agent list. user-settings is the source of truth for
// "who's actually an agent here" (see listAllUserSettings) -- everything
// else (email/name, org, last-active) is enrichment layered on top of that
// list, not a second source of identity.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonError(405, "Method not allowed");

  try {
    await requirePlatformAdmin(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const [settingsRecords, orgMembers] = await Promise.all([
    listAllUserSettings(),
    listAllOrgMembers(),
  ]);

  const orgIdByUser = new Map(orgMembers.map((m) => [m.userId, m.orgId]));
  const uniqueOrgIds = [...new Set(orgIdByUser.values())];
  const userIds = settingsRecords.map((s) => s.userId);

  const clerk = getClerkClient();

  let orgNameById = new Map();
  try {
    const orgs = await Promise.all(uniqueOrgIds.map((id) => clerk.organizations.getOrganization({ organizationId: id })));
    orgNameById = new Map(orgs.map((o) => [o.id, o.name]));
  } catch { /* org lookups best-effort -- agents still list without org names */ }

  let clerkUserById = new Map();
  if (userIds.length) {
    try {
      // Clerk's userId filter caps out well above any realistic agent count
      // here, so one batched call covers the whole list.
      const { data } = await clerk.users.getUserList({ userId: userIds, limit: userIds.length });
      clerkUserById = new Map(data.map((u) => [u.id, u]));
    } catch { /* Clerk lookups best-effort -- agents still list without email/name */ }
  }

  const agents = await Promise.all(settingsRecords.map(async (s) => {
    const cu = clerkUserById.get(s.userId);
    const orgId = orgIdByUser.get(s.userId) || null;
    return {
      userId: s.userId,
      email: cu?.emailAddresses?.[0]?.emailAddress || null,
      name: cu ? [cu.firstName, cu.lastName].filter(Boolean).join(" ") || null : null,
      licensedCarriers: s.licensedCarriers || [],
      defaultProductType: s.defaultProductType || null,
      orgId,
      orgName: orgId ? orgNameById.get(orgId) || null : null,
      lastActiveAt: await getLastSeenAt(s.userId),
    };
  }));

  agents.sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));

  return new Response(JSON.stringify({ agents }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
