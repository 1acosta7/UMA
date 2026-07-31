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

// Phase 4 (product-type organization). The 5 UI-facing buckets the agent can
// filter by -- deliberately the exact set requested, not auto-derived from
// every distinct productType string in Phase 1's JSON mapping (which had
// finer-grained values like "Participating Whole Life" or "FE/Simplified
// Issue (graded)"). GUL has no documented product in this library at all
// (confirmed during Phase 1 -- none of the 26 files describe a guaranteed-UL
// product) -- filtering to it correctly yields zero product-specific
// documents from every carrier; that's an accurate reflection of the source
// library, not a bug to work around.
export const PRODUCT_TYPES = ["iul", "term", "whole_life", "final_expense", "gul"];
export const PRODUCT_TYPE_NAMES = { iul: "IUL", term: "Term", whole_life: "Whole Life", final_expense: "Final Expense", gul: "GUL" };

// Per-slot product-type relevance, derived directly from Phase 1's full-
// document read (each file's own PRODUCT TYPE field in
// UNDERWRITING_KNOWLEDGE_BASE.md, and its confirmed JSON mapping).
// `crossCutting: true` means the document applies regardless of product-type
// filter (general/master UW guides, APS ordering process docs, financial UW,
// foreign-national/immigration eligibility, occupation overlays, product-line
// overview worksheets) -- it's excluded only by carrier licensing, never by
// a product-type filter. `productTypes` lists which of the 5 buckets a
// NON-cross-cutting document is actually relevant to; several Foresters/
// F&G/Allianz slots list more than one bucket because the single source PDF
// genuinely covers multiple product lines (e.g. Foresters' main UW guide
// covers Your Term/Strong Foundation [term], Advantage Plus II [whole_life],
// and SMART UL -- SMART UL isn't indexed and doesn't cleanly fit any of the
// 5 buckets on its own, so it's folded into the closest bucket, iul, rather
// than inventing a 6th "UL" bucket the user didn't ask for).
export const SLOT_PRODUCT_TYPES = {
  fg: {
    telephone_uw: { crossCutting: true, productTypes: [] },
    exam_free: { crossCutting: false, productTypes: ["iul"] },
    impairment: { crossCutting: false, productTypes: ["iul"] },
    afge: { crossCutting: false, productTypes: ["iul"] },
    natguard: { crossCutting: false, productTypes: ["iul"] },
    foreign_nat: { crossCutting: true, productTypes: [] },
  },
  foresters: {
    main_uw: { crossCutting: false, productTypes: ["term", "whole_life", "iul"] },
    main_uw_apr26: { crossCutting: false, productTypes: ["term", "whole_life", "iul"] },
    accel_uw: { crossCutting: false, productTypes: ["term", "whole_life"] }, // Your Term, SMART UL, Advantage Plus II only -- not Strong Foundation/PlanRight/BrightFuture, per Phase 1
    nonmed: { crossCutting: true, productTypes: [] }, // product-line overview across all 7 Foresters products
    diabetes: { crossCutting: false, productTypes: ["term", "whole_life"] }, // Your Term, Advantage Plus II, SMART UL only
    immigration: { crossCutting: true, productTypes: [] },
    brightfuture: { crossCutting: false, productTypes: ["whole_life"] }, // juvenile whole life
    planright: { crossCutting: false, productTypes: ["final_expense"] },
  },
  allianz: {
    uw_guide: { crossCutting: true, productTypes: [] },
    uw_financial: { crossCutting: true, productTypes: [] },
    uw_pathways: { crossCutting: true, productTypes: [] }, // covers Accelerated/Boosted (IUL-specific) AND the general Classic pathway
    aps: { crossCutting: true, productTypes: [] },
    athletes: { crossCutting: true, productTypes: [] },
    accel: { crossCutting: false, productTypes: ["iul"] }, // explicitly "single indexed universal life insurance policies" only
  },
  transamerica: {
    fe_express: { crossCutting: false, productTypes: ["final_expense"] },
    trendsetter: { crossCutting: false, productTypes: ["term"] },
    lifetime_wl: { crossCutting: false, productTypes: ["whole_life"] },
    ffiul_ii: { crossCutting: false, productTypes: ["iul"] },
    fciul_ii: { crossCutting: false, productTypes: ["iul"] },
    foreign_nat: { crossCutting: true, productTypes: [] },
  },
};

// null productType means no filter is active -- everything matches. An
// unrecognized (carrier, slotId) pair (a document not yet mapped above)
// fails OPEN (matches) rather than being silently excluded from every
// product-type filter forever -- the same fail-open posture used for
// licensedCarriers being unset in Phase 3.
export function docMatchesProductType(carrier, slotId, productType) {
  if (!productType) return true;
  const entry = SLOT_PRODUCT_TYPES[carrier]?.[slotId];
  if (!entry) return true;
  if (entry.crossCutting) return true;
  return entry.productTypes.includes(productType);
}

// Maps the intake extraction's productObjective enum (INTAKE_TOOL in
// chat.mjs) onto the 5 UI buckets above, for automatic inference when the
// agent hasn't explicitly picked a product-type filter. "annuity" and
// "other" have no mapping (return null -- no filter applied) since neither
// corresponds to a life-insurance product-type bucket in this system.
export function mapProductObjectiveToType(productObjective) {
  const map = {
    "final expense": "final_expense",
    "term": "term",
    "whole life": "whole_life",
    "universal life": "iul",
    "iul": "iul",
  };
  return map[String(productObjective || "").toLowerCase()] || null;
}

// Per-agent settings, one record per userId (no nesting -- unlike
// conversations/client-profiles, there's exactly one of these per agent, so
// the userId itself is the key). Phase 3's only field today is
// licensedCarriers, but this is the general home for future per-agent
// preferences rather than a licensing-specific store.
export async function getUserSettings(userId) {
  const store = getStore({ name: "user-settings", consistency: "strong" });
  try {
    const text = await store.get(userId, { type: "text" });
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function saveUserSettings(userId, patch) {
  const store = getStore({ name: "user-settings", consistency: "strong" });
  const existing = (await getUserSettings(userId)) || { userId, createdAt: new Date().toISOString() };
  const now = new Date().toISOString();
  const record = { ...existing, ...patch, userId, updatedAt: now };
  await store.set(userId, JSON.stringify(record), { metadata: { userId, updatedAt: now } });
  return record;
}

export function conversationKey(userId, conversationId) {
  return `${userId}/${conversationId}`;
}

// A client profile is the durable identity across conversations -- "this
// real person," independent of any single chat thread. A conversation
// record still IS the actual placement-analysis thread (turns, retrieval
// state, etc.); the profile just tracks which conversationIds belong to the
// same client over time (an initial term quote, then an IUL follow-up
// months later) so an agent can find them together instead of only ever
// resuming one thread at a time.
export function clientProfileKey(userId, clientProfileId) {
  return `${userId}/${clientProfileId}`;
}

export async function createClientProfile(userId, label, initialConversationId) {
  const store = getStore({ name: "client-profiles", consistency: "strong" });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const profile = {
    id, userId, label: label || "Untitled client", createdAt: now, updatedAt: now,
    conversationIds: initialConversationId ? [initialConversationId] : [],
  };
  await store.set(clientProfileKey(userId, id), JSON.stringify(profile), {
    metadata: { userId, label: profile.label, updatedAt: now },
  });
  return profile;
}

export async function loadClientProfile(userId, clientProfileId) {
  const store = getStore({ name: "client-profiles", consistency: "strong" });
  try {
    const text = await store.get(clientProfileKey(userId, clientProfileId), { type: "text" });
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function listClientProfiles(userId) {
  const store = getStore({ name: "client-profiles", consistency: "strong" });
  try {
    const { blobs } = await store.list({ prefix: `${userId}/` });
    const entries = await Promise.all(blobs.map((b) => store.get(b.key, { type: "text" })));
    return entries.filter(Boolean).map((t) => JSON.parse(t));
  } catch {
    return [];
  }
}

// Called once when a NEW conversation is started under an EXISTING client
// (as opposed to createClientProfile, which is for a brand-new client) --
// a single read-modify-write, not something that races with itself the way
// the conversation record's own per-turn saves do, since it's only ever
// called once per new conversation, at creation.
export async function addConversationToClientProfile(userId, clientProfileId, conversationId) {
  const store = getStore({ name: "client-profiles", consistency: "strong" });
  const profile = await loadClientProfile(userId, clientProfileId);
  if (!profile) throw new Error("Client profile not found");
  if (profile.userId !== userId) throw new Error("Client profile does not belong to this agent");
  if (!profile.conversationIds.includes(conversationId)) {
    profile.conversationIds.push(conversationId);
    profile.updatedAt = new Date().toISOString();
    await store.set(clientProfileKey(userId, clientProfileId), JSON.stringify(profile), {
      metadata: { userId, label: profile.label, updatedAt: profile.updatedAt },
    });
  }
  return profile;
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
