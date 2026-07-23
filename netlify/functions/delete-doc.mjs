import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
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

  if (!pin || pin !== Netlify.env.get("ADMIN_PIN")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (!carrier || !slotId) {
    return new Response(JSON.stringify({ error: "carrier and slotId are required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const store = getStore("carrier-docs");
  const key = `${carrier}_${slotId}`;

  try {
    await store.delete(key);
  } catch { /* key may not exist, that's fine */ }

  return new Response(JSON.stringify({ success: true, key }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
