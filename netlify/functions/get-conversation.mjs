import { getStore } from "@netlify/blobs";
import {
  CORS, jsonError, requireUser, clientDocPrefix,
  loadConversation, logAccess,
} from "./_shared.mjs";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const { conversationId } = await req.json();
  if (!conversationId) return jsonError(400, "conversationId is required");

  const convStore = getStore("conversations");
  const record = await loadConversation(convStore, userId, conversationId);
  if (!record || !record.turns || record.turns.length === 0) {
    return jsonError(404, "Conversation not found");
  }

  const clientStore = getStore("client-docs");
  let clientDocs = [];
  try {
    const { blobs } = await clientStore.list({ prefix: clientDocPrefix(userId, conversationId) });
    clientDocs = blobs.map((b) => ({
      filename: b.metadata?.filename || b.key.split("/").pop(),
      uploadedAt: b.metadata?.uploadedAt,
    }));
  } catch { /* no client docs */ }

  // Reopening a client's thread is itself a document access -- log it.
  // Independent write, not a mutation of `record` -- viewing a thread should
  // never need to re-save the conversation record itself.
  await logAccess(userId, conversationId, "view");

  return new Response(JSON.stringify({
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    profileText: record.profileText,
    carrierStatus: record.carrierStatus,
    clientDocs,
    turns: record.turns,
  }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
