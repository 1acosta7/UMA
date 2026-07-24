import { getStore } from "@netlify/blobs";
import {
  CORS, jsonError, requireUser, looksLikePdf,
  clientDocPrefix, loadConversation, saveConversation, logAccess,
} from "./_shared.mjs";

// Any signed-in agent may upload documents for their own client -- this is
// deliberately NOT admin-PIN-gated like carrier guideline uploads, since
// every agent manages their own clients' files independently.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { conversationId, filename, data } = await req.json();
  if (!conversationId || !filename || !data) {
    return jsonError(400, "conversationId, filename, and data are required");
  }

  const buf = Buffer.from(data, "base64");
  if (buf.byteLength > 4.5 * 1024 * 1024) {
    return jsonError(400, "File exceeds 4.5 MB limit");
  }
  if (!looksLikePdf(new Uint8Array(buf))) {
    return jsonError(400, "File does not appear to be a PDF");
  }

  const docId = crypto.randomUUID();
  const uploadedAt = new Date().toISOString();
  const clientStore = getStore({ name: "client-docs", consistency: "strong" });
  const key = `${clientDocPrefix(userId, conversationId)}${docId}`;
  await clientStore.set(key, buf, { metadata: { userId, conversationId, filename, uploadedAt } });

  // Ensure a stub conversation record exists even if analysis hasn't run yet,
  // so the doc's conversationId has somewhere to belong. chat.mjs fills the
  // rest in once analysis actually runs.
  const convStore = getStore({ name: "conversations", consistency: "strong" });
  let record = await loadConversation(convStore, userId, conversationId);
  if (!record) {
    record = { id: conversationId, userId, createdAt: uploadedAt, turns: [] };
    await saveConversation(convStore, userId, conversationId, record);
  }
  await logAccess(userId, conversationId, "upload");

  return new Response(JSON.stringify({ success: true, docId, key, filename, uploadedAt }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
