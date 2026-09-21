// Anonymous, account-free re-engagement push notifications.
//
// Deliberately NOT gated behind a login. Free tier's whole product story
// (and its Play Store submission -- CLAUDE.md, "Sign-in details: No") is
// "no account required for any functionality" -- adding a signup wall just
// to enable a push would contradict that and add friction at the exact
// moment re-engagement needs zero friction. A subscription is keyed to the
// same anonymous device_id every tier already generates for the Sep 17,
// 2026 device-visit counter (shared/device-id.ts) -- not to a person. No
// email, no phone number, nothing requested from the visitor beyond the
// browser's own native "Allow notifications?" permission prompt.

const webpush = require("web-push");

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT      || "mailto:support@tradetribunal.app";

const pushConfigured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("push-notifications: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set -- /push routes will 503, nothing will send.");
}

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSubscription(sub) {
  return !!(sub && typeof sub.endpoint === "string" && sub.endpoint.length > 0 &&
    sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string");
}

function mountPushRoutes(app, supabase) {
  // No auth requirement beyond the standard tier-secret middleware every
  // route already goes through (same posture as /device-ping) -- this
  // isn't sign-in-gated, so there's nothing further to check here.
  app.get("/push/vapid-public-key", (req, res) => {
    if (!pushConfigured) return res.status(503).json({ error: "Push not configured" });
    res.json({ publicKey: VAPID_PUBLIC_KEY });
  });

  app.post("/push/subscribe", async (req, res) => {
    if (!pushConfigured) return res.status(503).json({ error: "Push not configured" });
    const { deviceId, subscription } = req.body || {};
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      return res.status(400).json({ error: "Invalid deviceId" });
    }
    if (!isValidSubscription(subscription)) {
      return res.status(400).json({ error: "Invalid subscription" });
    }
    if (!supabase) return res.json({ success: true, stored: false });
    try {
      const { error } = await supabase.from("push_subscriptions").upsert({
        device_id:  deviceId,
        endpoint:   subscription.endpoint,
        p256dh:     subscription.keys.p256dh,
        auth:       subscription.keys.auth,
        tier:       req.userTier || null,
        disabled:   false,
        updated_at: new Date().toISOString(),
      }, { onConflict: "device_id" });
      if (error) throw error;
      res.json({ success: true });
    } catch (e) {
      console.error("POST /push/subscribe:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/push/unsubscribe", async (req, res) => {
    const { deviceId } = req.body || {};
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      return res.status(400).json({ error: "Invalid deviceId" });
    }
    if (!supabase) return res.json({ success: true });
    try {
      const { error } = await supabase.from("push_subscriptions").delete().eq("device_id", deviceId);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) {
      console.error("POST /push/unsubscribe:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

// Sends one payload to every active (non-disabled) subscription. A 404/410
// from the push service means the browser itself dropped the subscription
// (uninstalled, permission revoked, cleared site data) -- delete that row
// rather than retry it forever. Any other single-subscription failure is
// logged and skipped; one bad row must never block the rest of the batch.
async function sendPushToAllSubscribers(supabase, payload) {
  if (!pushConfigured || !supabase) return { sent: 0, removed: 0 };
  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("device_id, endpoint, p256dh, auth")
    .eq("disabled", false);
  if (error) {
    console.error("sendPushToAllSubscribers select:", error.message);
    return { sent: 0, removed: 0 };
  }
  let sent = 0, removed = 0;
  const body = JSON.stringify(payload);
  await Promise.allSettled((subs || []).map(async (row) => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(sub, body);
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        removed++;
        try { await supabase.from("push_subscriptions").delete().eq("device_id", row.device_id); } catch {}
      } else {
        console.error(`sendPushToAllSubscribers ${row.device_id}:`, e && e.message);
      }
    }
  }));
  return { sent, removed };
}

module.exports = { mountPushRoutes, sendPushToAllSubscribers, pushConfigured };
