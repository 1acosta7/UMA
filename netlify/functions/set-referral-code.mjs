import { CORS, jsonError, requireUserContext, setReferralCode } from "./_shared.mjs";

// Optional vanity link -- every agent already has a working random code
// from get-referral-link.mjs, this just lets them swap it for something
// memorable (their own name, typically). Any agent in an active org can
// call this for their own code -- no org:admin gate, same "every agent
// builds their own team" spirit as the referral link itself.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let ctx;
  try {
    ctx = await requireUserContext(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  if (!ctx.orgId) return jsonError(400, "No active organization");

  const { code } = await req.json().catch(() => ({}));
  const normalized = String(code || "").trim().toLowerCase();
  if (!/^[a-z0-9-]{3,30}$/.test(normalized)) {
    return jsonError(400, "Use 3-30 characters: lowercase letters, numbers, and hyphens only");
  }

  const result = await setReferralCode(ctx.orgId, ctx.userId, normalized);
  if (!result.ok) return jsonError(409, result.error);

  return new Response(JSON.stringify({ code: result.code }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
