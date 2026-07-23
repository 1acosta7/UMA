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

// Narrow, disclosed auxiliary step: pull search terms out of the client
// profile so we can find the relevant page in each carrier's documents.
// This model NEVER produces the underwriting analysis itself -- that always
// runs on claude-sonnet-5 below, with no fallback.
const KEYWORD_SYSTEM = `Extract 3-10 short search terms for the medical conditions, impairments, tobacco use, or product types mentioned in this client profile, in the plain terminology an insurance underwriting guide would use. Include medical synonyms (e.g. for a TIA case, include "TIA", "transient ischemic attack", "stroke"). Do not include age, gender, dollar amounts, or names.
Return JSON only: {"kw":["term1","term2"]}`;

const CARRIERS = ["fg", "foresters", "allianz", "transamerica"];
const CARRIER_NAMES = { fg: "F&G", foresters: "Foresters", allianz: "Allianz", transamerica: "Transamerica" };

async function checkAuth(authHeader) {
  const token = (authHeader || "").replace("Bearer ", "").trim();
  if (!token) throw new Error("Missing token");
  await verifyToken(token, { secretKey: Netlify.env.get("CLERK_SECRET_KEY") });
}

// Pull windows of text around keyword matches wherever they fall in the
// document, instead of blindly truncating from the start -- a blind slice
// can cut off before the actual decision-chart entry in a long document.
function extractRelevant(text, keywords, maxTotal) {
  const head = text.slice(0, 800);
  if (!keywords?.length) return { text: text.slice(0, maxTotal), matched: false };

  const windows = [];
  for (const kw of keywords) {
    const needle = kw.trim();
    if (!needle) continue;
    // Word-boundary match -- a plain substring search would match "TIA"
    // inside "essential", "substantial", "differentiate", etc.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      windows.push([Math.max(0, m.index - 1200), Math.min(text.length, m.index + needle.length + 1800)]);
    }
  }
  if (windows.length === 0) return { text: text.slice(0, maxTotal), matched: false };

  windows.sort((a, b) => a[0] - b[0]);
  const merged = [windows[0]];
  for (const [start, end] of windows.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1] + 200) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  let out = merged[0][0] > 0 ? head + "\n...\n" : "";
  let used = out.length;
  for (const [start, end] of merged) {
    if (used >= maxTotal) break;
    const chunk = text.slice(start, end);
    out += (out ? "\n...\n" : "") + chunk;
    used += chunk.length;
  }
  return { text: out.slice(0, maxTotal), matched: true };
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

  const { profile } = await req.json();
  if (!profile?.trim()) {
    return new Response(JSON.stringify({ error: "Client profile is required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const anthropic = new Anthropic({ apiKey: Netlify.env.get("ANTHROPIC_API_KEY") });
  const store = getStore("carrier-docs");

  // Step 1: extract search keywords from the client profile (claude-haiku-4-5,
  // extraction only -- see comment on KEYWORD_SYSTEM above).
  let keywords = [];
  try {
    const kwMsg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      system: KEYWORD_SYSTEM,
      messages: [{ role: "user", content: profile }],
    });
    const kwText = kwMsg.content?.[0]?.text ?? "";
    const parsed = JSON.parse(kwText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    keywords = parsed.kw ?? [];
  } catch {
    keywords = [];
  }

  // Step 2: assemble every carrier's guideline text. Every one of the 4
  // known carriers is represented, whether or not documents are uploaded
  // for it -- the system prompt has a hard rule that missing guidelines
  // must be stated explicitly, never guessed around.
  let allKeys = [];
  try {
    const { blobs } = await store.list();
    allKeys = blobs.map((b) => b.key);
  } catch { /* store empty or unavailable */ }

  const carrierStatus = {};
  const docSections = [];
  for (const carrier of CARRIERS) {
    const name = CARRIER_NAMES[carrier];
    const slotKeys = allKeys.filter((k) => k.startsWith(`${carrier}_`));
    if (slotKeys.length === 0) {
      carrierStatus[carrier] = "none";
      docSections.push(`\n\n=== ${name.toUpperCase()} ===\nNO GUIDELINES UPLOADED FOR THIS CARRIER.`);
      continue;
    }
    const perSlotBudget = Math.max(3000, Math.floor(18000 / slotKeys.length));
    let anyMatched = false;
    const parts = [];
    for (const key of slotKeys) {
      try {
        const blob = await store.get(key, { type: "text" });
        if (!blob) continue;
        const slotId = key.slice(carrier.length + 1);
        const result = extractRelevant(blob, keywords, perSlotBudget);
        if (result.matched) {
          anyMatched = true;
          parts.push(`--- ${slotId} ---\n${result.text}`);
        } else {
          // No keyword hit in this specific document -- note it exists
          // without spending context budget on it.
          parts.push(`--- ${slotId} --- (no specific mention of the stated conditions found in a keyword scan of this document)`);
        }
      } catch { /* skip */ }
    }
    carrierStatus[carrier] = anyMatched ? "matched" : "uploaded";
    docSections.push(`\n\n=== ${name.toUpperCase()} ===\n${parts.join("\n\n")}`);
  }

  // Step 3: analysis -- always claude-sonnet-5, no fallback to a cheaper model.
  const messages = [
    {
      role: "user",
      content: `${profile}\n\n<uploaded_guidelines>${docSections.join("")}\n</uploaded_guidelines>`,
    },
  ];

  const encoder = new TextEncoder();
  const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse("meta", { carrierStatus }));
      try {
        const anthropicStream = anthropic.messages.stream({
          model: "claude-sonnet-5",
          max_tokens: 16000,
          thinking: { type: "adaptive", display: "summarized" },
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
