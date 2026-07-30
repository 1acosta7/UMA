import { CORS, jsonError, requireUser, saveUserSettings, CARRIERS } from "./_shared.mjs";

// Phase 3 (carrier licensing). Used by both the first-login onboarding modal
// and the Setup-tab editor -- same endpoint, same effect: chat.mjs reads
// licensedCarriers fresh from this store on every request (see
// buildAnalysisContext), so a change here is effective on the agent's very
// next message, no re-login or redeploy required.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { licensedCarriers } = await req.json();
  if (!Array.isArray(licensedCarriers) || licensedCarriers.length === 0) {
    return jsonError(400, "licensedCarriers must be a non-empty array");
  }
  const valid = [...new Set(licensedCarriers.filter((c) => CARRIERS.includes(c)))];
  if (valid.length === 0) return jsonError(400, "No valid carrier ids provided");

  const settings = await saveUserSettings(userId, { licensedCarriers: valid });
  return new Response(JSON.stringify({ licensedCarriers: settings.licensedCarriers }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
