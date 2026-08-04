import { getStore } from "@netlify/blobs";
import { createClient } from "@supabase/supabase-js";
import { requirePlatformAdmin } from "./_shared.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { pin, carrier, slotId } = await req.json();

  // Two independent checks, both required -- see upload.mjs for why the PIN
  // alone was never actually tied to any identity.
  if (!pin || pin !== Netlify.env.get("ADMIN_PIN")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    await requirePlatformAdmin(req.headers.get("authorization"));
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (!carrier || !slotId) {
    return new Response(JSON.stringify({ error: "carrier and slotId are required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const store = getStore({ name: "carrier-docs", consistency: "strong" });
  const key = `${carrier}_${slotId}`;

  try {
    await store.delete(key);
  } catch { /* key may not exist, that's fine */ }

  // Also clear any narrative chunks ingested from this document -- otherwise
  // vector search keeps surfacing citations for a document that's been removed.
  try {
    const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_KEY"));
    await supabase.rpc("delete_guideline_chunks", { match_carrier: carrier, match_slot_id: slotId });
  } catch { /* Supabase not configured or unreachable -- blob deletion still succeeded */ }

  return new Response(JSON.stringify({ success: true, key }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
