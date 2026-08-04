import {
  CORS, jsonError, requireUserContext, getClerkClient,
  listOrgMembers, getUserSettings, getLastSeenAt,
} from "./_shared.mjs";

// Roster-only, by design: name, email, licensed carriers, last-active --
// never client profiles, conversations, or recommendations. A reporting
// line is an organizational fact, not a data-sharing grant; every other
// endpoint in this app still scopes strictly to the requesting agent's own
// userId regardless of who reports to whom, so this stays the one place a
// manager's view of their team lives.
async function enrich(member) {
  const settings = await getUserSettings(member.userId);
  return {
    userId: member.userId,
    reportsTo: member.reportsTo || null,
    role: member.role,
    licensedCarriers: settings?.licensedCarriers || [],
    lastActiveAt: await getLastSeenAt(member.userId),
  };
}

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
    return new Response(JSON.stringify({
      directReports: [], isOrgAdmin: false, orgRoster: null,
      _debugOrgRole: String(ctx.orgRole), _debugOrgId: String(ctx.orgId),
    }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const members = await listOrgMembers(ctx.orgId);
  const isOrgAdmin = ctx.orgRole === "org:admin";
  const directReportMembers = members.filter((m) => m.reportsTo === ctx.userId);
  const rosterMembers = isOrgAdmin ? members : directReportMembers;

  const enriched = await Promise.all(rosterMembers.map(enrich));
  const clerkUserById = new Map();
  try {
    const clerk = getClerkClient();
    const userIds = rosterMembers.map((m) => m.userId);
    if (userIds.length) {
      const { data } = await clerk.users.getUserList({ userId: userIds, limit: userIds.length });
      data.forEach((u) => clerkUserById.set(u.id, u));
    }
  } catch { /* Clerk lookups best-effort -- roster still shows without name/email */ }

  const withIdentity = enriched.map((e) => {
    const cu = clerkUserById.get(e.userId);
    return {
      ...e,
      email: cu?.emailAddresses?.[0]?.emailAddress || null,
      name: cu ? [cu.firstName, cu.lastName].filter(Boolean).join(" ") || null : null,
    };
  });

  const directReports = withIdentity.filter((m) => m.reportsTo === ctx.userId);
  const orgRoster = isOrgAdmin ? withIdentity : null;

  return new Response(JSON.stringify({
    directReports, isOrgAdmin, orgRoster,
    _debugOrgRole: String(ctx.orgRole), _debugOrgId: String(ctx.orgId),
  }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
