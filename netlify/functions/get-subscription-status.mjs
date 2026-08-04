import { CORS, jsonError, requireUser, isPlatformAdmin, getSubscriptionStatus } from "./_shared.mjs";

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

// Powers the Settings-panel billing status display. Deliberately returns
// enough for the UI to explain grace-period timing on its own (rather than
// just "past_due") -- an agent whose payment failed should see exactly when
// the pipeline actually blocks, not just that something's wrong.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  if (isPlatformAdmin(userId)) {
    return new Response(JSON.stringify({ isPlatformAdmin: true, status: null, gracePeriodEndsAt: null }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const record = await getSubscriptionStatus(userId);
  const gracePeriodEndsAt = record?.status === "past_due" && record?.pastDueSince
    ? new Date(Date.parse(record.pastDueSince) + GRACE_PERIOD_MS).toISOString()
    : null;

  return new Response(JSON.stringify({
    isPlatformAdmin: false,
    status: record?.status || null,
    pastDueSince: record?.pastDueSince || null,
    gracePeriodEndsAt,
  }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
