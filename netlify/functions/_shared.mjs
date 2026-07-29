import { verifyToken } from "@clerk/backend";
import { getStore } from "@netlify/blobs";

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

export const CARRIERS = ["fg", "foresters", "allianz", "transamerica"];
export const CARRIER_NAMES = { fg: "F&G", foresters: "Foresters", allianz: "Allianz", transamerica: "Transamerica" };

export const SLOT_LABELS = {
  fg: {
    telephone_uw: "Life UW Telephone Interview Guide",
    exam_free: "Exam-Free Underwriting Guide",
    impairment: "Impairment Field UW Guide",
    afge: "AFGE (federal employees union) Field UW Guide",
    natguard: "National Guard Field UW Guide",
    foreign_nat: "Foreign National UW Categories",
  },
  foresters: {
    main_uw: "Main UW Guide (Your Term, Strong Foundation, Advantage Plus II, SMART UL)",
    main_uw_apr26: "Main UW Guide — Apr 2026 Edition",
    accel_uw: "Accelerated UW Program Guide",
    nonmed: "Non-Med Platform Worksheet (product overview, not an impairment guide)",
    diabetes: "Diabetes Ratings for Non-Med Business",
    immigration: "Immigration Guidelines for Non-US Citizens",
    brightfuture: "BrightFuture Children's Whole Life UW Guide (juvenile applicants only)",
    planright: "PlanRight Medical Reference Guide",
  },
  allianz: {
    uw_guide: "Underwriting Guidelines",
    uw_financial: "Underwriting Guidelines — Financial (large face amounts / high net worth)",
    uw_pathways: "Underwriting Pathways",
    aps: "APS Ordering Guidelines (process document, not medical decisions)",
    athletes: "Professional Athletes UW Guidelines",
    accel: "Accelerated UW Program Brochure",
  },
  transamerica: {
    fe_express: "FE Express Solution Agent & UW Guide (final expense)",
    trendsetter: "Trendsetter Term Life Agent & UW Guide",
    lifetime_wl: "Lifetime Whole Life UW Field Guide",
    ffiul_ii: "FFIUL II Express Agent & UW Guide (IUL)",
    fciul_ii: "FCIUL II Agent Guide (IUL)",
    foreign_nat: "Foreign National ITIN UW Guidelines",
  },
};

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
// documents, doing what, and when. Deliberately NOT stored as a field on the
// conversation record -- that record is read-modify-written on every call
// (load, mutate turns, save), and two calls landing close together (e.g.
// reopening a thread right as a follow-up is being sent) can race, with the
// second save silently clobbering the first's accessLog entry. Each log
// entry is instead its own blind write to a dedicated store, keyed uniquely,
// so logging can never lose an entry to a conversation-record race.
export async function logAccess(userId, conversationId, action) {
  const store = getStore({ name: "access-log", consistency: "strong" });
  const key = `${userId}/${conversationId}/${Date.now()}-${crypto.randomUUID()}`;
  try {
    await store.set(key, JSON.stringify({ userId, conversationId, action, timestamp: new Date().toISOString() }));
  } catch { /* audit logging must never block the underlying operation */ }
}

export async function readAccessLog(userId, conversationId) {
  const store = getStore({ name: "access-log", consistency: "strong" });
  try {
    const { blobs } = await store.list({ prefix: `${userId}/${conversationId}/` });
    const entries = await Promise.all(blobs.map((b) => store.get(b.key, { type: "text" })));
    return entries.filter(Boolean).map((t) => JSON.parse(t)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

// Structured, machine-readable recommendation records -- one per analysis
// turn that actually produced a recommendation (not per conversation, and
// not per follow-up question that didn't). Deliberately a SEPARATE store
// from `conversations`: that record is read-modify-written on every turn
// (see loadConversation/saveConversation above) and a later turn's save
// would silently overwrite an earlier turn's recommendation if this lived
// as a field on it. Every key is unique (timestamp+uuid) so a record, once
// written, is never the target of a future write from a *different*
// analysis turn -- the only legitimate mutation of an existing key is the
// agent-review update below, which is an intentional, narrow field-level
// patch (agent_reviewed/agent_agreed), not a silent overwrite.
export function recommendationKey(userId, conversationId, timestamp, id) {
  return `${userId}/${conversationId}/${timestamp}-${id}`;
}

export async function saveRecommendation(record) {
  const store = getStore({ name: "recommendations", consistency: "strong" });
  const id = crypto.randomUUID();
  const key = recommendationKey(record.userId, record.conversationId, record.timestamp, id);
  const full = { ...record, id, key };
  await store.set(key, JSON.stringify(full), { metadata: { userId: record.userId, conversationId: record.conversationId } });
  return full;
}

export async function listRecommendations(userId, conversationId) {
  const store = getStore({ name: "recommendations", consistency: "strong" });
  try {
    const { blobs } = await store.list({ prefix: `${userId}/${conversationId}/` });
    const entries = await Promise.all(blobs.map((b) => store.get(b.key, { type: "text" })));
    return entries.filter(Boolean).map((t) => JSON.parse(t)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

// The one sanctioned update path: an agent marking whether they later
// learned the real carrier outcome, and whether it matched. This is the
// shadow-mode validation dataset -- there's no pre-existing labeled-outcome
// set, so this is how one gets built up over time. Scoped to exactly these
// two review fields (plus a reviewedAt stamp) so it can never be used to
// rewrite the original recommendation itself.
export async function updateRecommendationReview(userId, conversationId, key, { agentReviewed, agentAgreed, notes }) {
  const store = getStore({ name: "recommendations", consistency: "strong" });
  const text = await store.get(key, { type: "text" });
  if (!text) throw new Error("Recommendation not found");
  const record = JSON.parse(text);
  if (record.userId !== userId || record.conversationId !== conversationId) throw new Error("Recommendation does not belong to this conversation");
  record.agentReviewed = !!agentReviewed;
  record.agentAgreed = agentAgreed === null || agentAgreed === undefined ? null : !!agentAgreed;
  record.reviewNotes = notes || null;
  record.reviewedAt = new Date().toISOString();
  await store.set(key, JSON.stringify(record), { metadata: { userId, conversationId } });
  return record;
}
