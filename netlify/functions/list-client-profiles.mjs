import { getStore } from "@netlify/blobs";
import { CORS, jsonError, requireUser, listClientProfiles, loadConversation } from "./_shared.mjs";

// Powers the grouped sidebar: one entry per client, each carrying its
// conversation history (label/updatedAt only, not full turn text) so the
// agent sees "John Smith" once, expandable into every thread for that
// client over time, instead of a flat list of raw conversations.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return jsonError(405, "Method not allowed");

  let userId;
  try {
    userId = await requireUser(req.headers.get("authorization"));
  } catch {
    return jsonError(401, "Unauthorized");
  }

  const profiles = await listClientProfiles(userId);
  const convStore = getStore({ name: "conversations", consistency: "strong" });

  const enriched = await Promise.all(profiles.map(async (p) => {
    const conversations = await Promise.all((p.conversationIds || []).map(async (cid) => {
      const record = await loadConversation(convStore, userId, cid);
      // Skip stub-only conversations (a client doc uploaded but analysis
      // never run) -- matches list-conversations.mjs's existing rule that
      // there's nothing to show in the sidebar for those yet.
      if (!record || !record.turns || record.turns.length === 0) return null;
      if (record.deleted) return null;
      return { id: record.id, label: record.label || "Untitled", createdAt: record.createdAt, updatedAt: record.updatedAt };
    }));
    const validConversations = conversations.filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return { id: p.id, label: p.label, createdAt: p.createdAt, updatedAt: p.updatedAt, conversations: validConversations };
  }));

  const withConversations = enriched.filter((p) => p.conversations.length > 0);
  withConversations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return new Response(JSON.stringify({ clientProfiles: withConversations }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
