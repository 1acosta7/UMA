import { CORS, jsonError, requireUserContext, createClientProfile } from "./_shared.mjs";

// Explicit "new client" creation -- an agent naming a client before
// starting any conversation for them. Most conversations still create their
// client profile implicitly (see chat.mjs), this is for the case where the
// agent wants to set up the client first (e.g. to attach documents before
// ever sending a profile).
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let userId, orgId;
  try {
    const ctx = await requireUserContext(req.headers.get("authorization"));
    userId = ctx.userId;
    orgId = ctx.orgId;
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { label } = await req.json();
  const profile = await createClientProfile(userId, label, null, orgId);
  return new Response(JSON.stringify({ success: true, clientProfile: profile }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
