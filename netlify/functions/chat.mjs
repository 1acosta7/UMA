import { getStore } from "@netlify/blobs";
import { verifyToken } from "@clerk/backend";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROUTING_SYSTEM = `You are an insurance underwriting router. Select the best carrier(s) and document slot(s).

CRITICAL RULE for any health impairment/medical condition question: simplified-issue (SI) products often have a completely different, more favorable single-condition decision chart than a carrier's fully-underwritten guide (e.g. a condition may be an immediate "Select" or graded-benefit approval on an SI chart while the fully-underwritten guide requires a 6-12 month postpone for the same condition). You MUST ALWAYS include each carrier's SI slot alongside its fully-underwritten slot for impairment questions — never rely on the fully-underwritten guide alone. SI slots per carrier: fg → exam_free. foresters → planright (and/or nonmed). allianz → accel. transamerica → fe_express.
Fully-underwritten general reference per carrier: fg → impairment. foresters → main_uw. allianz → uw_guide. transamerica → trendsetter (term) or lifetime_wl (whole life).

Other routing: Non-med/exam-free → exam_free, accel_uw, nonmed. Final expense → fe_express, planright. Term life → trendsetter, main_uw. IUL/LIRP → uw_pathways, ffiul_ii, fciul_ii. Whole life/IBC → main_uw, main_uw_apr26. Foreign nationals → foreign_nat, immigration. Diabetes → diabetes. Military → natguard, afge. Athletes → athletes. APS → aps. Large face amounts → uw_financial.

If the question asks broadly which carrier(s) to use, asks to compare carriers/options, or says things like "what carriers can we work with" / "which carrier is best" / "who can we place this with" — this is a CROSS-CARRIER COMPARISON. You MUST return all 4 carriers (fg, foresters, allianz, transamerica). For a health-impairment comparison, each carrier's slots MUST include its SI slot (per the rule above) alongside its fully-underwritten reference. Do not narrow to just one or two carriers, and do not skip the SI slot, for these questions.

For a narrow question about one specific product or carrier already named by the user, max 2 carriers, max 2 slots each.

Return JSON only: {"r":[{"c":"carrier_id","s":["slot_id"],"note":"reason"}]}`;

const ANSWER_SYSTEM = `You are a professional insurance underwriting assistant. Answer based ONLY on provided documents. Lead with direct answer. Cite exact document and page/section if visible. Give precise numbers — face amounts, age bands, table ratings, flat extras. Note exceptions.
When a carrier has both a simplified-issue (SI) chart and a fully-underwritten guide in the provided documents, check BOTH and present whichever gives the client the fastest/most favorable outcome — don't default to only the fully-underwritten answer if the SI product is more favorable. When comparing across carriers, rank recommendations with the best/fastest option first. If not found, say so.`;

async function checkAuth(authHeader) {
  const token = (authHeader || "").replace("Bearer ", "").trim();
  if (!token) throw new Error("Missing token");
  await verifyToken(token, { secretKey: Netlify.env.get("CLERK_SECRET_KEY") });
}

async function callAnthropic(system, messages, maxTokens = 256, model = "claude-opus-4-5") {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Netlify.env.get("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
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
      500,
      "claude-haiku-4-5"
    );
    const parsed = JSON.parse(routeText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    routing = parsed.r ?? [];
  } catch {
    routing = [];
  }

  // Step 2: Load matched docs from blob store
  const searched = [];
  const docBlocks = [];

  const totalSlots = routing.reduce((n, r) => n + (r.s?.length ?? 0), 0);
  const perDocLimit = Math.min(30000, Math.max(8000, Math.floor(60000 / Math.max(1, totalSlots))));

  for (const route of routing) {
    const carrier = route.c;
    const slots = route.s ?? [];
    for (const slotId of slots) {
      const key = `${carrier}_${slotId}`;
      try {
        const blob = await store.get(key, { type: "text" });
        if (blob) {
          searched.push(key);
          docBlocks.push(`\n\n=== ${carrier.toUpperCase()} / ${slotId} ===\n${blob.slice(0, perDocLimit)}`);
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
            docBlocks.push(`\n\n=== ${b.key} ===\n${blob.slice(0, 30000)}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* no docs at all */ }
  }

  const contextBlock = docBlocks.length > 0
    ? `<documents>${docBlocks.join("")}\n</documents>`
    : "<documents>No documents have been uploaded yet.</documents>";

  // Step 3: Answer — streamed as SSE so long multi-carrier comparisons
  // aren't cut off by the platform's synchronous function time limit.
  const messages = [
    ...history.slice(-8),
    { role: "user", content: `${question}\n\n${contextBlock}` },
  ];

  const encoder = new TextEncoder();
  const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse("meta", { routing, searched }));
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": Netlify.env.get("ANTHROPIC_API_KEY"),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-opus-4-5",
            max_tokens: 4096,
            system: ANSWER_SYSTEM,
            messages,
            stream: true,
          }),
        });
        if (!res.ok || !res.body) {
          controller.enqueue(sse("error", { error: `Anthropic error: ${res.status}` }));
          controller.close();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop();
          for (const evt of events) {
            const dataLine = evt.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(6));
              if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
                controller.enqueue(sse("delta", { text: parsed.delta.text }));
              }
            } catch { /* ignore partial/non-JSON lines */ }
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
