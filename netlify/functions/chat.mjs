import { getStore } from "@netlify/blobs";
import { createClerk } from "@clerk/backend";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROUTING_SYSTEM = `You are an insurance underwriting router. Select the best carrier(s) and document slot(s).
Routing logic: Health impairments → impairment guides. Non-med/exam-free → exam_free, accel_uw, nonmed. Final expense → fe_express, planright. Term life → trendsetter, main_uw. IUL/LIRP → uw_pathways, ffiul_ii. Whole life/IBC → main_uw, main_uw_apr26. Foreign nationals → foreign_nat, immigration. Diabetes → diabetes. Military → natguard, afge. Athletes → athletes. APS → aps. Large face amounts → uw_financial.
Return JSON only: {"r":[{"c":"carrier_id","s":["slot_id"],"note":"reason"}]}
Max 2 carriers, max 2 slots each.`;

const ANSWER_SYSTEM = `You are a professional insurance underwriting assistant. Answer based ONLY on provided documents. Lead with direct answer. Cite exact document. Give precise numbers — face amounts, age bands, table ratings, flat extras. Note exceptions. If not found, say so.`;

async function verifyToken(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Missing token");
  const token = authHeader.slice(7).trim();
  const clerk = createClerk({ secretKey: Netlify.env.get("CLERK_SECRET_KEY") });
  const payload = await clerk.verifyToken(token);
  if (!payload?.sub) throw new Error("Invalid token");
  return payload.sub;
}

async function callAnthropic(system, messages, maxTokens = 256) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Netlify.env.get("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Auth
  try {
    await verifyToken(req.headers.get("authorization"));
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

  const { question, history = [] } = await req.json();
  if (!question?.trim()) {
    return new Response(JSON.stringify({ error: "question is required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const store = getStore("carrier-docs");

  // Step 1: Route
  let routing = [];
  try {
    const routeText = await callAnthropic(
      ROUTING_SYSTEM,
      [{ role: "user", content: question }],
      256
    );
    const parsed = JSON.parse(routeText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    routing = parsed.r ?? [];
  } catch {
    routing = [];
  }

  // Step 2: Load matched docs from blob store
  const searched = [];
  const docBlocks = [];

  for (const route of routing) {
    const carrier = route.c;
    const slots = route.s ?? [];
    for (const slotId of slots) {
      const key = `${carrier}_${slotId}`;
      try {
        const blob = await store.get(key, { type: "text" });
        if (blob) {
          searched.push(key);
          docBlocks.push(`\n\n=== ${carrier.toUpperCase()} / ${slotId} ===\n${blob.slice(0, 30000)}`);
        }
      } catch { /* not uploaded yet */ }
    }
  }

  // Fallback: if no docs matched, search all
  if (docBlocks.length === 0) {
    try {
      const { blobs } = await store.list();
      for (const b of blobs.slice(0, 6)) {
        try {
          const blob = await store.get(b.key, { type: "text" });
          if (blob) {
            searched.push(b.key);
            docBlocks.push(`\n\n=== ${b.key} ===\n${blob.slice(0, 15000)}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* no docs at all */ }
  }

  const contextBlock = docBlocks.length > 0
    ? `<documents>${docBlocks.join("")}\n</documents>`
    : "<documents>No documents have been uploaded yet.</documents>";

  // Step 3: Answer
  const messages = [
    ...history.slice(-8),
    { role: "user", content: `${question}\n\n${contextBlock}` },
  ];

  const reply = await callAnthropic(ANSWER_SYSTEM, messages, 2048);

  return new Response(JSON.stringify({ reply, routing, searched }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
