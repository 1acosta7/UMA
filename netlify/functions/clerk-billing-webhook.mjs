import { Webhook } from "svix";
import { CORS, getSubscriptionStatus, setSubscriptionStatus } from "./_shared.mjs";

// Receives Clerk Billing's subscription lifecycle events (subscription.*,
// subscriptionItem.*) and mirrors the current status into our own
// subscription-status store -- see hasActiveAccess() in _shared.mjs for why
// this needs to be webhook-driven rather than read from the session token's
// `pla` claim on every request: this is the only signal that fires exactly
// once, at the moment a payment actually fails, which is what the grace-
// period clock in hasActiveAccess() is built on.
//
// Status-driven, not event-type-driven: Clerk's webhook payload carries a
// `status` field on the subscription/item object (e.g. "active", "trialing",
// "past_due", "canceled") that reflects current state regardless of which
// event type fired it -- reading that directly is more robust than trying
// to enumerate every documented event type name exactly right, especially
// since Clerk's own Billing docs were noticeably thinner than their session-
// token reference on several of these specifics. NOTE: this file has not
// been exercised against a real webhook delivery yet (Stripe isn't
// connected, no live subscription exists) -- smoke-test it with
// `npx clerk@latest webhooks listen` against a real test subscription
// before relying on it in production, and adjust the field paths below if
// the real payload shape differs from what's documented here.
//
// Requires CLERK_BILLING_WEBHOOK_SECRET (the Svix signing secret Clerk
// shows when you create this webhook endpoint in the Dashboard) as a
// Netlify env var -- not something set here, and not something I have or
// asked for.
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const secret = Netlify.env.get("CLERK_BILLING_WEBHOOK_SECRET");
  if (!secret) {
    return new Response(JSON.stringify({ error: "Webhook not configured" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Svix verification needs the exact raw body -- must read as text before
  // any JSON parsing, or the signature check fails on the re-serialized copy.
  const payload = await req.text();
  const svixHeaders = {
    "svix-id": req.headers.get("svix-id"),
    "svix-timestamp": req.headers.get("svix-timestamp"),
    "svix-signature": req.headers.get("svix-signature"),
  };

  let evt;
  try {
    evt = new Webhook(secret).verify(payload, svixHeaders);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { type, data } = evt;

  // Org-billing events would carry payer.organization_id instead -- we only
  // ever enable user billing, but skip defensively rather than assume.
  const userId = data?.payer?.user_id;
  if (!userId) {
    return new Response(JSON.stringify({ received: true, skipped: "no user_id payer" }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const status = data?.status;
  if (status === "active" || status === "trialing") {
    await setSubscriptionStatus(userId, { status, pastDueSince: null, lastEventType: type });
  } else if (status === "past_due") {
    // Only stamp pastDueSince the FIRST time we see past_due -- a later
    // duplicate/retried webhook for the same lapse must not reset the
    // grace-period clock back to "now".
    const existing = await getSubscriptionStatus(userId);
    if (existing?.status !== "past_due") {
      await setSubscriptionStatus(userId, { status: "past_due", pastDueSince: new Date().toISOString(), lastEventType: type });
    } else {
      await setSubscriptionStatus(userId, { lastEventType: type });
    }
  } else if (status === "canceled" || status === "incomplete_expired" || status === "unpaid") {
    await setSubscriptionStatus(userId, { status: "canceled", pastDueSince: null, lastEventType: type });
  }
  // Any other/unrecognized status: leave the stored record untouched rather
  // than guess -- an unmapped status shouldn't silently downgrade an
  // otherwise-active agent.

  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
