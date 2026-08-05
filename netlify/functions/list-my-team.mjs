import {
  CORS, jsonError, requireUserContext, getClerkClient,
  listOrgMembers, getUserSettings, getLastSeenAt, countClientProfilesForUser,
} from "./_shared.mjs";

// Full downline, not just direct reports -- BFS over the reportsTo pointers
// already on each org-members record (no new store needed, reportsTo alone
// is enough to derive an arbitrarily deep tree). depth=1 is a direct
// report, depth=2 reports to one of those, etc., so the UI can indent.
// visited-set guards against a cycle turning this into an infinite loop --
// set-reports-to.mjs also rejects cycles at assignment time, but this stays
// defensive in case one ever exists anyway.
function buildDownline(members, rootUserId) {
  const byManager = new Map();
  for (const m of members) {
    if (!m.reportsTo) continue;
    if (!byManager.has(m.reportsTo)) byManager.set(m.reportsTo, []);
    byManager.get(m.reportsTo).push(m);
  }
  const result = [];
  const visited = new Set([rootUserId]);
  const queue = (byManager.get(rootUserId) || []).map((m) => ({ member: m, depth: 1 }));
  while (queue.length) {
    const { member, depth } = queue.shift();
    if (visited.has(member.userId)) continue;
    visited.add(member.userId);
    result.push({ member, depth });
    for (const r of byManager.get(member.userId) || []) queue.push({ member: r, depth: depth + 1 });
  }
  return result;
}

// Roster plus a bare client COUNT, never client data itself: name, email,
// licensed carriers, last-active, and how many client profiles someone has
// -- never a name, condition, or anything else about who those clients are.
// A reporting line is an organizational fact, not a data-sharing grant;
// every other endpoint in this app still scopes strictly to the requesting
// agent's own userId regardless of who reports to whom, so this stays the
// one place a manager's view of their team lives, and the count is the one
// deliberate, bounded exception to "never client data."
async function enrich(member) {
  const settings = await getUserSettings(member.userId);
  return {
    userId: member.userId,
    reportsTo: member.reportsTo || null,
    role: member.role,
    licensedCarriers: settings?.licensedCarriers || [],
    lastActiveAt: await getLastSeenAt(member.userId),
    clientCount: await countClientProfilesForUser(member.userId),
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
    return new Response(JSON.stringify({ downline: [], isOrgAdmin: false, orgRoster: null }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const members = await listOrgMembers(ctx.orgId);
  const isOrgAdmin = ctx.orgRole === "org:admin";
  const downlineEntries = buildDownline(members, ctx.userId);
  const rosterMembers = isOrgAdmin ? members : downlineEntries.map((e) => e.member);

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

  const identityById = new Map(enriched.map((e) => {
    const cu = clerkUserById.get(e.userId);
    return [e.userId, {
      ...e,
      email: cu?.emailAddresses?.[0]?.emailAddress || null,
      name: cu ? [cu.firstName, cu.lastName].filter(Boolean).join(" ") || null : null,
    }];
  }));

  const downline = downlineEntries.map(({ member, depth }) => ({
    ...identityById.get(member.userId),
    depth,
  }));
  const orgRoster = isOrgAdmin ? [...identityById.values()] : null;

  return new Response(JSON.stringify({ downline, isOrgAdmin, orgRoster }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
