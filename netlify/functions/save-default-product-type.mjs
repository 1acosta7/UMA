import { CORS, jsonError, requireUser, saveUserSettings, PRODUCT_TYPES } from "./_shared.mjs";

// Separate endpoint rather than folding this into save-user-settings.mjs --
// that endpoint's validation hard-requires a non-empty licensedCarriers on
// every call, so a request that only wants to change this one preference
// would fail it. Both endpoints call the same saveUserSettings(userId, patch)
// merge-patch helper underneath, so they compose safely on the same
// underlying record without stepping on each other's fields.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { defaultProductType } = await req.json();
  // null/empty clears the preference back to "Auto" -- not an error, that's
  // the documented unset state (see PRODUCT_TYPE_NAMES usage in app.html).
  if (defaultProductType && !PRODUCT_TYPES.includes(defaultProductType)) {
    return jsonError(400, "Invalid product type");
  }

  const settings = await saveUserSettings(userId, { defaultProductType: defaultProductType || null });
  return new Response(JSON.stringify({ defaultProductType: settings.defaultProductType }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
