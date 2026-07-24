import { getStore } from "@netlify/blobs";
import { verifyToken } from "@clerk/backend";

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

  return new Response(JSON.stringify({ keys }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
