import { runVerification } from "./_verify.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Admin-PIN-gated like the other content-management endpoints (this is
// content-management, not agent-facing search). Called from three places:
// the Setup tab's manual "Run verification" button, automatically at the
// end of every upload, and by the post-deploy build plugin.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { pin } = await req.json().catch(() => ({}));
  if (!pin || pin !== Netlify.env.get("ADMIN_PIN")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const report = await runVerification();
  return new Response(JSON.stringify(report), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
