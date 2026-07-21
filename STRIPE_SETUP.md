# Trade Verdict — Stripe Setup Guide

## Step 1 — Create Stripe Products

In Stripe Dashboard → Products → Add Product:

### Product 1: Trade Verdict Starter
- Name: `Trade Verdict Starter`
- Price: `$9.99` recurring monthly
- Copy the **Price ID** (looks like `price_xxx`) — you'll need it

### Product 2: Trade Verdict Pro  
- Name: `Trade Verdict Pro`
- Price: `$16.99` recurring monthly
- Copy the **Price ID**

### Product 3: Trade Verdict Shark
- Name: `Trade Verdict Shark`
- Price: `$39.99` recurring monthly
- Copy the **Price ID**

### Product 4: Credits Pack (one-time)
- Name: `Trade Verdict Credits — 10 pack`
- Price: `$0.99` one-time
- Copy the **Price ID**

---

## Step 2 — Create Payment Links

For each product, go to Payment Links → Create:
- Select the product
- Add a field for **Email** (required — this is how the server identifies the user)
- Copy the payment link URL

You'll have 4 payment links:
- Starter link → share with $9.99 subscribers
- Pro link → share with $16.99 subscribers  
- Shark link → share with $39.99 subscribers
- Credits link → embed in free/starter/pro app versions

---

## Step 3 — Add Environment Variables to Render

Go to Render → your service → Environment → Add these:

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Your Stripe secret key (sk_live_xxx or sk_test_xxx) |
| `STRIPE_WEBHOOK_SECRET` | From Step 4 below |
| `STRIPE_STARTER_PRICE_ID` | price_xxx from Starter product |
| `STRIPE_PRO_PRICE_ID` | price_xxx from Pro product |
| `STRIPE_SHARK_PRICE_ID` | price_xxx from Shark product |

---

## Step 4 — Set Up Stripe Webhook

In Stripe Dashboard → Developers → Webhooks → Add Endpoint:

- **URL:** `https://tra-zacg.onrender.com/stripe/webhook`
- **Events to listen for:**
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
  - `payment_intent.succeeded` (for credit purchases)

After saving, copy the **Signing Secret** → add to Render as `STRIPE_WEBHOOK_SECRET`

---

## Step 5 — Manual Deploy in Render

After adding all environment variables → Manual Deploy

Startup logs should show:
```
Stripe key:  true
Stripe WH:   true
```

---

## Step 6 — Update HTML Files

In each tier's index.html, replace `YOUR_STRIPE_LINK_HERE` with the correct payment link:

- `index_free.html` → Starter payment link (upgrade from free)
- `index_starter.html` → Pro payment link (upgrade from starter)
- `index_pro.html` → Shark payment link (upgrade from pro)

For the credits button, use the Credits Pack payment link in all files.

---

## How Subscriptions Work After Setup

1. User clicks payment link in app
2. Enters email and payment on Stripe hosted page
3. Stripe fires webhook to your server
4. Server automatically upgrades their tier
5. You email them their tier-specific URL (manual for now, automated later)

## Tier URLs To Send Subscribers

After a user subscribes, email them their pro URL:

| Tier | URL |
|---|---|
| Starter | `https://turneraroundauto-hub.github.io/trade-verdict/starter/` |
| Pro | `https://turneraroundauto-hub.github.io/trade-verdict/pro/` |
| Shark | `https://turneraroundauto-hub.github.io/trade-verdict/shark/` |

Their APP_SECRET (tier key) is baked into each HTML file.

---

## Testing With Stripe Test Mode

Before going live, use Stripe test mode:
- Test card: `4242 4242 4242 4242` any future expiry any CVC
- Test secret key starts with `sk_test_`
- Switch to live keys when ready to charge real cards

