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

  const { pin, carrier, slotId, data } = await req.json();

  if (!pin || pin !== Netlify.env.get("ADMIN_PIN")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (!carrier || !slotId || !data) {
    return new Response(JSON.stringify({ error: "carrier, slotId, and data are required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const buf = Buffer.from(data, "base64");
  if (buf.byteLength > 4.5 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: "File exceeds 4.5 MB limit" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") {
    return new Response(JSON.stringify({ error: "File does not appear to be a PDF" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Store the raw PDF bytes -- chat.mjs sends them to Claude as native PDF
  // document blocks so the model reads the actual table layout instead of a
  // flattened, column-ambiguous text extraction.
  const store = getStore({ name: "carrier-docs", consistency: "strong" });
  const key = `${carrier}_${slotId}`;
  await store.set(key, buf, {
    metadata: { carrier, slotId, uploadedAt: new Date().toISOString() },
  });

  return new Response(JSON.stringify({ success: true, key }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
