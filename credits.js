
// ═══════════════════════════════════════════════════════════════════
// CREDIT SYSTEM — Trade Tribunal
// ═══════════════════════════════════════════════════════════════════
// Storage: Supabase (the existing public.credits table + RPC functions
// added on top of it, see supabase-ddl-patch5-credits.sql), with every
// mutation going through an atomic Postgres function instead of app-level
// read-then-write —
// needed because "Analyze All" fires one /analyze call per watchlist
// ticker concurrently, and a naive read/modify/write over the network
// could let two concurrent deducts double-spend the same balance.
//
// Falls back to an in-memory + JSON-file store (the original
// implementation) when server.js never calls setSupabase() with a real
// client — e.g. local dev without SUPABASE_URL/SUPABASE_SERVICE_KEY set.
// That fallback is NOT safe for production: Render's default web
// service disk is ephemeral, so a file-backed store there silently
// loses every balance on every deploy/restart. Configure Supabase.
//
// CREDIT ECONOMICS: 1 credit == 3 ticker analyses, across every tier.
// server.js still deducts by ticker count (1 per /analyze call, before
// the Anthropic call) — deductCredit/deduct_user_credit is what converts
// analysis-count into credit-count, via a 0-2 pending_analyses counter
// per user that only decrements a whole credit on the 3rd analysis since
// the last one. This keeps the credit balance shown to users a true
// whole number of fully-available 3-packs. The Anthropic call is capped
// at max_tokens:800 on claude-sonnet-4-6 (~$0.02/analysis), so a full
// credit now costs the business ~$0.06 — re-check that math if the
// model, max_tokens, or the 3-per-credit ratio ever changes.
// ═══════════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const CREDIT_FILE = path.join(__dirname, "credits.json");

let supabaseClient = null;
function setSupabase(client) {
  supabaseClient = client;
}

// ── TIER DEFINITIONS ──────────────────────────────────────────────
// Mirrored in supabase-ddl-patch5-credits.sql's RPC functions — if you
// change credits/rollover amounts here, update the SQL too.
const TIERS = {
  free: {
    name:          "Free",
    monthlyCredits: 0,          // free tier does NOT get a monthly allowance
    maxTickers:    3,
    cacheMinutes:  15,
    pulse:         false,
    tracker:       false,
    glossary:      true,
    alpaca:        false,
    earnings:      false,
    iv:            false,
    scorecard:     false,       // Proposal 7, Aug 26 2026 -- rolling out Pro-first, trickling down
    agitator:      false,       // Proposal 5, Aug 26 2026 -- rolling out Pro-first, trickling down
    dial:          false,       // Proposal 6, Aug 26 2026 -- rolling out Pro-first, trickling down    maxRollover:   45,
    price:         9.99,
  },
  // iv is intentionally separate from `alpaca` — alpaca gates Shark's Gate 3
  // SWING_LEVEL mode and future deep-analytics surface (see alpacaKeys()'s
  // comment in server.js); Pro getting implied-volatility data for its CSV
  // export doesn't mean Pro should also pick up Shark's other Alpaca usage.
  pro: {
    name:          "Pro",
    monthlyCredits: 100,
    maxTickers:    999,
    cacheMinutes:  1,
    pulse:         true,
    tracker:       true,
    glossary:      true,
    alpaca:        false,
    earnings:      false,
    iv:            true,
    scorecard:     true,        // Proposal 7, Aug 26 2026 -- first tier to get it
    agitator:      true,        // Proposal 5, Aug 26 2026 -- first tier to get it
    dial:          true,        // Proposal 6, Aug 26 2026 -- first tier to get it    maxRollover:   45,
    price:         39.99,
  },
};

// 1 credit buys this many ticker analyses, across every tier. Must match
// the literal `3` used in supabase-ddl-patch5-credits.sql's
// deduct_user_credit — only the local fallback store reads this constant;
// the Supabase path's math lives entirely in that SQL function.
const ANALYSES_PER_CREDIT = 3;

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
}

// Fixed 7-day buckets since the Unix epoch — simple, timezone-free, and
// deterministic (no ISO-week edge cases to get wrong). Must match the
// `floor(extract(epoch from now()) / 604800)` expression used in the SQL.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function currentWeekKey() {
  return Math.floor(Date.now() / WEEK_MS);
}

function getTotalCredits(user) {
  return (user.credits || 0) + (user.purchasedCredits || 0);
}

function statusFromUser(user) {
  const tierConfig = TIERS[user.tier] || TIERS.free;
  return {
    tier:             user.tier,
    tierName:         tierConfig.name,
    credits:          user.credits,
    purchasedCredits: user.purchasedCredits,
    totalCredits:     getTotalCredits(user),
    maxTickers:       tierConfig.maxTickers,
    cacheMinutes:     tierConfig.cacheMinutes,
    features:         {
      pulse:    tierConfig.pulse,
      tracker:  tierConfig.tracker,
      glossary: tierConfig.glossary,
      alpaca:   tierConfig.alpaca,
      earnings:  tierConfig.earnings,
      iv:        tierConfig.iv,
      scorecard: tierConfig.scorecard,
      agitator:  tierConfig.agitator,
      dial:      tierConfig.dial,
    },
    lastReset:       user.lastReset,
    lastWeeklyReset: user.lastWeeklyReset,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SUPABASE-BACKED STORE (primary — used whenever setSupabase() has
// been called with a real client)
// ═══════════════════════════════════════════════════════════════════

function rowToUser(row) {
  return {
    tier:             row.tier,
    credits:          row.credits,
    purchasedCredits: row.purchased_credits,
    lastReset:        row.last_reset,
    lastWeeklyReset:  row.last_weekly_reset,
  };
}

async function rpc(fn, args) {
  const { data, error } = await supabaseClient.rpc(fn, args);
  if (error) throw new Error(`credits.${fn} failed: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function getUserSupabase(apiKey, tier) {
  const row = await rpc("get_or_create_user_credits", { p_key: apiKey, p_tier: tier || null });
  return rowToUser(row);
}

async function deductCreditSupabase(apiKey, count, tier) {
  const row = await rpc("deduct_user_credit", { p_key: apiKey, p_tier: tier || null, p_count: count });
  return !!row.success;
}

async function addPurchasedCreditsSupabase(apiKey, count, tier) {
  const row = await rpc("add_purchased_credits", { p_key: apiKey, p_tier: tier || null, p_count: count });
  return getTotalCredits(rowToUser(row));
}

async function upgradeTierSupabase(apiKey, newTier) {
  if (!TIERS[newTier]) return false;
  await rpc("upgrade_user_tier", { p_key: apiKey, p_new_tier: newTier });
  return true;
}

async function setTierSupabase(apiKey, tier) {
  if (!TIERS[tier]) return false;
  await rpc("set_user_tier", { p_key: apiKey, p_new_tier: tier });
  return true;
}

async function getUserStatusSupabase(apiKey, tier) {
  const user = await getUserSupabase(apiKey, tier);
  return statusFromUser(user);
}

// ═══════════════════════════════════════════════════════════════════
// LOCAL FALLBACK STORE (in-memory + JSON file — dev/no-Supabase only,
// NOT durable on Render's ephemeral disk, see header)
// ═══════════════════════════════════════════════════════════════════

let creditStore = {};

function loadCreditsLocal() {
  try {
    if (fs.existsSync(CREDIT_FILE)) {
      creditStore = JSON.parse(fs.readFileSync(CREDIT_FILE, "utf8"));
      console.log(`Local credit store loaded: ${Object.keys(creditStore).length} users`);
    }
  } catch(e) {
    console.error("Local credit store load failed:", e.message);
    creditStore = {};
  }
}

function saveCreditsLocal() {
  try {
    fs.writeFileSync(CREDIT_FILE, JSON.stringify(creditStore, null, 2));
  } catch(e) {
    console.error("Local credit store save failed:", e.message);
  }
}

function getUserLocal(apiKey, tier) {
  const initTier = (tier && TIERS[tier]) ? tier : "free";
  if (!creditStore[apiKey]) {
    creditStore[apiKey] = {
      tier:             initTier,
      credits:          TIERS[initTier].startingCredits ?? TIERS[initTier].monthlyCredits,
      purchasedCredits: 0,
      pendingAnalyses:  0,
      lastReset:        currentMonthKey(),
      lastWeeklyReset:  currentWeekKey(),
      createdAt:        new Date().toISOString(),
    };
    saveCreditsLocal();
  }
  const user = creditStore[apiKey];
  if (tier && TIERS[tier] && user.tier !== tier) {
    user.tier = tier;
  }
  return user;
}

function checkMonthlyResetLocal(user) {
  const thisMonth = currentMonthKey();
  if (user.lastReset === thisMonth) return;

  const tier = TIERS[user.tier] || TIERS.free;
  const unusedCredits = Math.max(0, user.credits);
  const rollover      = Math.min(unusedCredits, tier.maxRollover ?? 45);

  user.credits   = rollover + tier.monthlyCredits;
  user.lastReset = thisMonth;
  saveCreditsLocal();
}

function checkWeeklyResetLocal(user) {
  const thisWeek = currentWeekKey();
  if (user.lastWeeklyReset === thisWeek) return;

  user.credits         = TIERS.free.startingCredits;
  user.lastWeeklyReset = thisWeek;
  saveCreditsLocal();
}

function checkResetLocal(user) {
  if (user.tier === "free") checkWeeklyResetLocal(user);
  else checkMonthlyResetLocal(user);
}

// 1 credit = 3 ticker analyses. `count` is ticker-analyses just run
// (always 1 in practice), not a credit amount — the balance check below
// is deliberately "< 1 whole credit", not "< count", since a request
// only needs *a* credit to draw down, not a full credit's worth of
// remaining analyses. Mirrors deduct_user_credit in
// supabase-ddl-patch5-credits.sql; keep the two in sync.
function deductCreditLocal(apiKey, count, tier) {
  const user = getUserLocal(apiKey, tier);
  checkResetLocal(user);

  if (getTotalCredits(user) < 1) return false;

  let pending = (user.pendingAnalyses || 0) + count;
  const wholeToSpend = Math.floor(pending / ANALYSES_PER_CREDIT);
  pending = pending % ANALYSES_PER_CREDIT;

  for (let i = 0; i < wholeToSpend; i++) {
    if (user.purchasedCredits > 0) user.purchasedCredits -= 1;
    else if (user.credits > 0) user.credits -= 1;
    else break; // guarded against by the balance check above; defensive only
  }
  user.pendingAnalyses = pending;

  saveCreditsLocal();
  return true;
}

function addPurchasedCreditsLocal(apiKey, count, tier) {
  const user = getUserLocal(apiKey, tier);
  user.purchasedCredits = (user.purchasedCredits || 0) + count;
  saveCreditsLocal();
  return getTotalCredits(user);
}

function upgradeTierLocal(apiKey, newTier) {
  if (!TIERS[newTier]) return false;
  const user = getUserLocal(apiKey, newTier);
  user.tier  = newTier;
  const tier = TIERS[newTier];
  user.credits   = Math.min(user.credits, tier.maxRollover ?? 45) + tier.monthlyCredits;
  user.lastReset = currentMonthKey();
  saveCreditsLocal();
  return true;
}

function setTierLocal(apiKey, tier) {
  if (!TIERS[tier]) return false;
  const user = getUserLocal(apiKey, tier);
  user.tier  = tier;
  saveCreditsLocal();
  return true;
}

function getUserStatusLocal(apiKey, tier) {
  const user = getUserLocal(apiKey, tier);
  checkResetLocal(user);
  return statusFromUser(user);
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API — dispatches to Supabase when configured, else local
// fallback. All async so callers (server.js) can treat both the same.
// ═══════════════════════════════════════════════════════════════════

function loadCredits() {
  // No-op with Supabase backend — only the local fallback needs a
  // boot-time load from disk.
  if (!supabaseClient) loadCreditsLocal();
}

async function getUser(apiKey, tier) {
  return supabaseClient ? getUserSupabase(apiKey, tier) : getUserLocal(apiKey, tier);
}

async function getUserStatus(apiKey, tier) {
  return supabaseClient ? getUserStatusSupabase(apiKey, tier) : getUserStatusLocal(apiKey, tier);
}

async function deductCredit(apiKey, count = 1, tier) {
  return supabaseClient ? deductCreditSupabase(apiKey, count, tier) : deductCreditLocal(apiKey, count, tier);
}

async function addPurchasedCredits(apiKey, count, tier) {
  return supabaseClient ? addPurchasedCreditsSupabase(apiKey, count, tier) : addPurchasedCreditsLocal(apiKey, count, tier);
}

async function upgradeTier(apiKey, newTier) {
  return supabaseClient ? upgradeTierSupabase(apiKey, newTier) : upgradeTierLocal(apiKey, newTier);
}

// Tier-only sync, no credit change — used on subscription cancellation
// (downgrade to free, credits preserved). Replaces the old pattern of
// calling getUser() and mutating .tier directly, which only worked
// because the local store held plain objects by reference; that doesn't
// exist over a Supabase RPC, so it needs its own explicit write.
async function setTier(apiKey, tier) {
  return supabaseClient ? setTierSupabase(apiKey, tier) : setTierLocal(apiKey, tier);
}

module.exports = {
  TIERS,
  setSupabase,
  loadCredits,
  getUser,
  getUserStatus,
  deductCredit,
  addPurchasedCredits,
  upgradeTier,
  setTier,
  getTotalCredits,
};
