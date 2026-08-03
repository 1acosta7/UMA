import { getStore } from "@netlify/blobs";
import {
  CORS, jsonError, requireUser, loadConversation, saveConversation,
  removeConversationFromClientProfile, logAccess,
} from "./_shared.mjs";

// Soft-delete only. recommendations and access-log are separate stores keyed
// off userId/conversationId independently of this record (see saveRecommendation/
// logAccess in _shared.mjs) -- a hard delete here would leave those pointing at
// a conversationId that no longer resolves, without actually freeing anything
// or removing them. Flagging the conversation record and filtering it out of
// list-conversations.mjs keeps every existing reference intact and queryable.
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

  const convStore = getStore({ name: "conversations", consistency: "strong" });
  // loadConversation keys on `${userId}/${conversationId}` -- a conversation
  // belonging to a different agent simply doesn't load, same structural
  // ownership check used by get-conversation.mjs.
  const record = await loadConversation(convStore, userId, conversationId);
  if (!record) return jsonError(404, "Conversation not found");

  const now = new Date().toISOString();
  record.deleted = true;
  record.deletedAt = now;
  record.updatedAt = now;
  await saveConversation(convStore, userId, conversationId, record);

  if (record.clientProfileId) {
    try {
      await removeConversationFromClientProfile(userId, record.clientProfileId, conversationId);
    } catch { /* profile already gone/detached -- the conversation delete itself still stands */ }
  }

  await logAccess(userId, conversationId, "delete");

  return new Response(JSON.stringify({ ok: true, id: conversationId }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
