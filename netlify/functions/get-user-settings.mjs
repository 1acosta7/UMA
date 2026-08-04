import { CORS, jsonError, requireUser, getUserSettings } from "./_shared.mjs";

// Phase 3 (carrier licensing). licensedCarriers: null means the agent hasn't
// completed onboarding yet (or the record doesn't exist) -- the frontend
// treats that as "show the onboarding modal," not as "licensed for nothing."
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const settings = await getUserSettings(userId);
  return new Response(JSON.stringify({
    licensedCarriers: settings?.licensedCarriers || null,
    defaultProductType: settings?.defaultProductType || null,
  }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
