import { verifyToken } from "@clerk/backend";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Verifies the Clerk session token and returns the authenticated user's ID
// (the JWT's `sub` claim). Every conversation/client-doc key is namespaced
// by this value, and every read checks the requested key actually belongs
// to the caller -- this is what makes one agent's archived clients
// structurally unreadable by another agent, not just policy-enforced.
export async function requireUser(authHeader) {
  const token = (authHeader || "").replace("Bearer ", "").trim();
  if (!token) throw new Error("Missing token");
  const claims = await verifyToken(token, { secretKey: Netlify.env.get("CLERK_SECRET_KEY") });
  if (!claims?.sub) throw new Error("Invalid token");
  return claims.sub;
}

export function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function looksLikePdf(bytes) {
  return bytes.length > 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
}

export function conversationKey(userId, conversationId) {
  return `${userId}/${conversationId}`;
}

export function clientDocPrefix(userId, conversationId) {
  return `${userId}/${conversationId}/`;
}

export async function loadConversation(store, userId, conversationId) {
  try {
    const text = await store.get(conversationKey(userId, conversationId), { type: "text" });
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function saveConversation(store, userId, conversationId, record) {
  await store.set(conversationKey(userId, conversationId), JSON.stringify(record), {
    metadata: { userId, label: record.label || "", updatedAt: record.updatedAt },
  });
}

// Lightweight, non-compliance-grade paper trail: who touched this client's
// documents, doing what, and when. Lives inline on the conversation record
// rather than a separate audit store, per explicit instruction that this is
// a placeholder pending real compliance infrastructure.
export function logAccess(record, userId, action) {
  if (!record.accessLog) record.accessLog = [];
  record.accessLog.push({ userId, action, timestamp: new Date().toISOString() });
}
