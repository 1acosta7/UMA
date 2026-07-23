import { getStore } from "@netlify/blobs";
import { verifyToken } from "@clerk/backend";
import Anthropic from "@anthropic-ai/sdk";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Verbatim, unmodified per the operator's Claude Project system prompt.
const SYSTEM_PROMPT = `You are my personal life insurance underwriting assistant. I am a licensed life insurance professional. Your job is to help me determine which carriers will approve my clients and at what rate class, based on their health profile.

---

WHAT I WILL GIVE YOU:
For each client, I will provide:
- Age, gender, height, weight
- Tobacco/nicotine use (type, frequency, last use)
- Medical history (diagnoses, dates, medications, surgeries)
- Family history (parents/siblings, cause of death, age at death)
- Financial information if relevant (income, net worth for large face amounts)
- Desired coverage amount and product type

---

YOUR KNOWLEDGE BASE:
I have uploaded underwriting guidelines for the following carriers and products into this project. Use ONLY this uploaded material to make decisions. Do not guess or use general knowledge for carrier-specific rules.

---

WHAT YOU WILL DO:
1. Review the client profile I provide
2. Cross-reference against each carrier's uploaded guidelines
3. For each carrier/product, tell me:
   - ✅ LIKELY APPROVED — and at what rate class (Preferred Plus, Preferred, Standard Plus, Standard, Table rating)
   - ⚠️ POSSIBLE ISSUES — flag any health conditions that may cause a rating or exclusion
   - ❌ LIKELY DECLINED — and the specific reason based on their guidelines
4. Rank carriers from most favorable to least favorable for this client
5. Suggest which product type fits best (term, IUL, whole life, final expense) based on their profile and any coverage limitations

---

OUTPUT FORMAT:
Use this structure every time:

CLIENT SNAPSHOT
- Name (or initials): 
- Age / Gender:
- Height / Weight / Build class:
- Tobacco: 
- Key Medical Flags:

CARRIER ANALYSIS
[Carrier Name] — [Product]
- Likely Outcome: ✅ / ⚠️ / ❌
- Estimated Rate Class:
- Notes / Flags:

RECOMMENDATION
- Best carrier option(s) for this client
- Product recommendation
- Any pre-submission notes (informal inquiry suggested, APS likely, etc.)

---

IMPORTANT RULES:
- Always cite the specific guideline or page from the uploaded documents when flagging an issue
- If a client's condition falls in a gray area, say so clearly and suggest an informal inquiry
- Never guarantee approval — frame everything as "likely" or "based on guidelines"
- If I haven't uploaded guidelines for a carrier yet, tell me rather than guessing`;

const CARRIERS = ["fg", "foresters", "allianz", "transamerica"];
const CARRIER_NAMES = { fg: "F&G", foresters: "Foresters", allianz: "Allianz", transamerica: "Transamerica" };

// Human-readable labels for each uploaded slot, mirrored from the Setup tab's
// CARRIERS config in app.html. Used only for the document-selection step below
// -- the model never sees these labels, only the actual PDFs it selects.
const SLOT_LABELS = {
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

// Narrow, disclosed auxiliary step: given the client profile and the list of
// documents actually uploaded per carrier, pick which ones are worth sending
// in full. This model NEVER produces the underwriting analysis itself -- that
// always runs on claude-sonnet-5 below, with no fallback. Sending every
// uploaded document for every carrier regardless of relevance would blow past
// both the context window and the function's time budget, so this step exists
// purely to bound size -- it is deliberately biased toward over-including
// rather than under-including, since a missed document produces a wrong
// underwriting call while an extra one only costs a bit of context.
const DOC_SELECT_SYSTEM = `You are selecting which underwriting guideline documents to load for a specific client scenario, given a list of documents actually available per carrier.
Rules:
- Always include documents that are general/main underwriting guides, impairment guides, or medical reference guides -- these contain the core condition-to-rate-class decision tables and apply to nearly every case.
- Only include a narrow, population-specific document (diabetes-specific, foreign national/immigration, professional athletes, military/government-employee-specific, children's/juvenile products) if the client profile clearly matches that population.
- Never include purely administrative/process documents (e.g. telephone interview guides, APS ordering guides) -- they contain no condition-specific rate class decisions.
- If you are unsure whether a document applies, include it. Omitting a relevant document produces a wrong underwriting call; including an extra one only costs a bit of context.
Return JSON only: {"carrier_id": ["slotId1","slotId2"], ...} -- one array per carrier that has at least one available document, using the exact slot IDs given.`;

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

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { profile, debug } = await req.json();
  if (!profile?.trim()) {
    return new Response(JSON.stringify({ error: "Client profile is required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const anthropic = new Anthropic({ apiKey: Netlify.env.get("ANTHROPIC_API_KEY") });
  const store = getStore("carrier-docs");

  // Step 1: figure out what's actually uploaded, keyed by carrier.
  let allKeys = [];
  try {
    const { blobs } = await store.list();
    allKeys = blobs.map((b) => b.key).sort();
  } catch { /* store empty or unavailable */ }

  const carrierStatus = {};
  const available = {}; // carrier -> [{id, label}]
  for (const carrier of CARRIERS) {
    const slotKeys = allKeys.filter((k) => k.startsWith(`${carrier}_`));
    if (slotKeys.length === 0) {
      carrierStatus[carrier] = "none";
      continue;
    }
    carrierStatus[carrier] = "uploaded";
    available[carrier] = slotKeys.map((k) => {
      const slotId = k.slice(carrier.length + 1);
      return { id: slotId, label: SLOT_LABELS[carrier]?.[slotId] || slotId };
    });
  }

  // Step 2: pick which of the available documents to actually load in full,
  // per DOC_SELECT_SYSTEM above (claude-haiku-4-5, selection only).
  let selected = {};
  if (Object.keys(available).length > 0) {
    try {
      const selMsg = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1000,
        system: DOC_SELECT_SYSTEM,
        messages: [
          {
            role: "user",
            content: `CLIENT PROFILE:\n${profile}\n\nAVAILABLE DOCUMENTS PER CARRIER:\n${JSON.stringify(available, null, 2)}`,
          },
        ],
      });
      const selText = selMsg.content?.[0]?.text ?? "";
      selected = JSON.parse(selText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {
      // If selection fails for any reason, fall back to everything available
      // rather than silently sending nothing.
      for (const carrier of Object.keys(available)) {
        selected[carrier] = available[carrier].map((d) => d.id);
      }
    }
  }

  // Step 3: fetch the selected PDFs as raw bytes and build native document
  // blocks -- Claude reads the actual table layout instead of a flattened,
  // column-ambiguous text extraction. Citations are enabled so page-level
  // citations in the answer are grounded in the real document, not guessed.
  const contentBlocks = [];
  for (const carrier of CARRIERS) {
    const name = CARRIER_NAMES[carrier];
    if (carrierStatus[carrier] === "none") {
      contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()}: NO GUIDELINES UPLOADED FOR THIS CARRIER ===` });
      continue;
    }
    const slotIds = selected[carrier]?.length ? selected[carrier] : available[carrier].map((d) => d.id);
    const docBlocks = [];
    for (const slotId of slotIds) {
      const key = `${carrier}_${slotId}`;
      try {
        const buf = await store.get(key, { type: "arrayBuffer" });
        if (!buf) continue;
        // Guard against stale entries from the previous text-extraction pipeline
        // (which stored plain text, not PDF bytes, under these same keys) --
        // skip anything that isn't actually a PDF rather than sending Claude
        // invalid document data and failing the whole request.
        const bytes = new Uint8Array(buf);
        const looksLikePdf = bytes.length > 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
        if (!looksLikePdf) continue;
        docBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: Buffer.from(buf).toString("base64") },
          title: `${name} — ${SLOT_LABELS[carrier]?.[slotId] || slotId}`,
          citations: { enabled: true },
        });
      } catch { /* skip unreadable doc */ }
    }
    if (docBlocks.length === 0) {
      carrierStatus[carrier] = "none";
      contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()}: NO GUIDELINES UPLOADED FOR THIS CARRIER ===` });
      continue;
    }
    contentBlocks.push({ type: "text", text: `\n\n=== ${name.toUpperCase()} GUIDELINE DOCUMENTS ===` });
    contentBlocks.push(...docBlocks);
  }
  // Cache breakpoint on the last static block: the document set only changes
  // when someone uploads/deletes a file, so repeated requests within the
  // cache TTL reuse this processing instead of re-reading every PDF.
  if (contentBlocks.length) {
    contentBlocks[contentBlocks.length - 1].cache_control = { type: "ephemeral" };
  }

  if (debug) {
    return new Response(JSON.stringify({ available, selected, carrierStatus, blockCount: contentBlocks.length }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Step 4: analysis -- always claude-sonnet-5, no fallback to a cheaper model.
  const messages = [
    {
      role: "user",
      content: [...contentBlocks, { type: "text", text: profile }],
    },
  ];

  const encoder = new TextEncoder();
  const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse("meta", { carrierStatus }));
      try {
        // Thinking disabled: Netlify kills this function at a hard 60s wall-clock
        // limit (confirmed via function logs), and adaptive thinking was consuming
        // enough of that budget that the answer itself got cut off mid-generation
        // on a full 4-carrier comparison. The model's analytical depth comes from
        // claude-sonnet-5 + the system prompt, not from exposing separate thinking
        // tokens, so disabling it trades invisible reasoning time for more of the
        // 60s budget going toward the actual CLIENT SNAPSHOT/CARRIER ANALYSIS/
        // RECOMMENDATION text.
        const anthropicStream = anthropic.messages.stream({
          model: "claude-sonnet-5",
          max_tokens: 8000,
          thinking: { type: "disabled" },
          system: SYSTEM_PROMPT,
          messages,
        });
        for await (const event of anthropicStream) {
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              controller.enqueue(sse("delta", { text: event.delta.text }));
            } else if (event.delta.type === "thinking_delta") {
              controller.enqueue(sse("thinking", { text: event.delta.thinking }));
            }
          }
        }
      } catch (err) {
        controller.enqueue(sse("error", { error: err.message }));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
