import { getStore } from "@netlify/blobs";
import { clientProfileKey } from "./_shared.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// One-time migration: every existing conversation predates clientProfileId.
// Backfills a 1:1 client profile per existing conversation (client =
// conversation is the safe default for pre-existing data -- there's no way
// to know from the data alone which older conversations belonged to the
// same real person). Idempotent and safe to re-run: any conversation that
// already has a clientProfileId is skipped, so re-running after a partial
// failure only picks up what's left. dryRun:true reports counts without
// writing anything -- always call that first.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { pin, dryRun } = await req.json();
  if (!pin || pin !== Netlify.env.get("ADMIN_PIN")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const convStore = getStore({ name: "conversations", consistency: "strong" });
  const profileStore = getStore({ name: "client-profiles", consistency: "strong" });
  const docStore = getStore({ name: "client-docs", consistency: "strong" });
  const recStore = getStore({ name: "recommendations", consistency: "strong" });

  let convBlobs = [];
  try {
    ({ blobs: convBlobs } = await convStore.list());
  } catch (err) {
    return new Response(JSON.stringify({ error: `Could not list conversations: ${err.message}` }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const totalConversations = convBlobs.length;
  let alreadyTagged = 0;
  const toBackfill = [];

  for (const b of convBlobs) {
    let text;
    try {
      text = await convStore.get(b.key, { type: "text" });
    } catch { continue; }
    if (!text) continue;
    let record;
    try { record = JSON.parse(text); } catch { continue; }
    if (record.clientProfileId) { alreadyTagged++; continue; }
    toBackfill.push({ key: b.key, record });
  }

  if (dryRun) {
    return new Response(JSON.stringify({
      dryRun: true,
      totalConversations,
      alreadyTagged,
      wouldBackfill: toBackfill.length,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let backfilledConversations = 0, backfilledDocs = 0, backfilledRecs = 0;
  const errors = [];

  for (const { key, record } of toBackfill) {
    try {
      const clientProfileId = crypto.randomUUID();
      const now = new Date().toISOString();
      const profile = {
        id: clientProfileId, userId: record.userId,
        label: record.label || "Untitled client",
        createdAt: record.createdAt || now, updatedAt: record.updatedAt || now,
        conversationIds: [record.id],
      };
      await profileStore.set(clientProfileKey(record.userId, clientProfileId), JSON.stringify(profile), {
        metadata: { userId: record.userId, label: profile.label, updatedAt: profile.updatedAt },
      });

      record.clientProfileId = clientProfileId;
      await convStore.set(key, JSON.stringify(record), {
        metadata: { userId: record.userId, label: record.label || "", updatedAt: record.updatedAt },
      });
      backfilledConversations++;

      // Stamp any client-docs already uploaded for this conversation.
      try {
        const { blobs: docBlobs } = await docStore.list({ prefix: `${record.userId}/${record.id}/` });
        for (const db of docBlobs) {
          const buf = await docStore.get(db.key, { type: "arrayBuffer" });
          if (!buf) continue;
          const existing = await docStore.getMetadata(db.key);
          await docStore.set(db.key, buf, { metadata: { ...(existing?.metadata || {}), clientProfileId } });
          backfilledDocs++;
        }
      } catch { /* best-effort -- conversation/profile backfill already succeeded */ }

      // Stamp any recommendation records already saved for this conversation.
      try {
        const { blobs: recBlobs } = await recStore.list({ prefix: `${record.userId}/${record.id}/` });
        for (const rb of recBlobs) {
          const rtext = await recStore.get(rb.key, { type: "text" });
          if (!rtext) continue;
          const rrecord = JSON.parse(rtext);
          if (rrecord.clientProfileId) continue;
          rrecord.clientProfileId = clientProfileId;
          await recStore.set(rb.key, JSON.stringify(rrecord), { metadata: { userId: record.userId, conversationId: record.id } });
          backfilledRecs++;
        }
      } catch { /* best-effort -- conversation/profile backfill already succeeded */ }
    } catch (err) {
      errors.push({ key, error: err.message });
    }
  }

  return new Response(JSON.stringify({
    dryRun: false,
    totalConversations, alreadyTagged,
    backfilledConversations, backfilledDocs, backfilledRecs,
    errors,
  }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}
