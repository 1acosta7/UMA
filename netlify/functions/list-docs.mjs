import { getStore } from "@netlify/blobs";
import { verifyToken } from "@clerk/backend";
import { createClient } from "@supabase/supabase-js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function checkAuth(authHeader) {
  const token = (authHeader || "").replace("Bearer ", "").trim();
  if (!token) throw new Error("Missing token");
  await verifyToken(token, { secretKey: Netlify.env.get("CLERK_SECRET_KEY") });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    await checkAuth(req.headers.get("authorization"));
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const store = getStore({ name: "carrier-docs", consistency: "strong" });
  let keys = [];
  try {
    const { blobs } = await store.list();
    keys = blobs.map((b) => b.key);
  } catch { /* store empty or unavailable */ }

  // A 100%-narrative document has no carrier-docs blob by design (there's no
  // table content worth keeping as a native PDF) -- relying on blob keys
  // alone here marks every such document "not uploaded" and offers Upload
  // instead of Replace, even though it's fully indexed and searchable. Merge
  // in anything ingestion_status has a record for so this list matches what's
  // actually live, not just what has a native PDF sitting alongside it.
  try {
    const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_KEY"));
    const { data } = await supabase.from("ingestion_status").select("carrier, slot_id");
    const statusKeys = (data || []).map((r) => `${r.carrier}_${r.slot_id}`);
    keys = [...new Set([...keys, ...statusKeys])];
  } catch { /* Supabase not reachable -- fall back to blob-only keys */ }

  return new Response(JSON.stringify({ keys }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
