import { getStore } from "@netlify/blobs";
import { CORS, jsonError, requireUser } from "./_shared.mjs";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const store = getStore("conversations");
  let keys = [];
  try {
    const { blobs } = await store.list({ prefix: `${userId}/` });
    keys = blobs.map((b) => b.key);
  } catch { /* store empty or unavailable */ }

  const items = [];
  for (const key of keys) {
    try {
      const text = await store.get(key, { type: "text" });
      if (!text) continue;
      const record = JSON.parse(text);
      // Skip stub records that only exist because a client doc was uploaded
      // before analysis ever ran -- nothing to show in the sidebar yet.
      if (!record.turns || record.turns.length === 0) continue;
      items.push({
        id: record.id,
        label: record.label || "Untitled client",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    } catch { /* skip unreadable record */ }
  }

  items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return new Response(JSON.stringify({ conversations: items }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
