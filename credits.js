// ═══════════════════════════════════════════════════════════════════
// CREDIT SYSTEM — Trade Verdict (Supabase backend)
// ═══════════════════════════════════════════════════════════════════

// ── TIER DEFINITIONS ──────────────────────────────────────────────
const TIERS = {
  free: {
    name:           "Free",
    monthlyCredits: 0,
    maxTickers:     3,
    cacheMinutes:   15,
    pulse:          false,
    tracker:        false,
    glossary:       true,
    alpaca:         false,
    earnings:       false,
    maxRollover:    45,
    startingCredits:3,
  },
  starter: {
    name:           "Starter",
    monthlyCredits: 45,
    maxTickers:     7,
    cacheMinutes:   5,
    pulse:          true,
    tracker:        false,
    glossary:       true,
    alpaca:         false,
    earnings:       false,
    maxRollover:    45,
    price:          9.99,
  },
  pro: {
    name:           "Pro",
    monthlyCredits: 100,
    maxTickers:     999,
    cacheMinutes:   1,
    pulse:          true,
    tracker:        true,
    glossary:       true,
    alpaca:         false,
    earnings:       false,
    maxRollover:    45,
    price:          16.99,
  },
  shark: {
    name:           "Shark",
    monthlyCredits: 145,
    maxTickers:     999,
    cacheMinutes:   1,
    pulse:          true,
    tracker:        true,
    glossary:       true,
    alpaca:         true,
    earnings:       true,
    maxRollover:    45,
    price:          39.99,
  },
};

// ── SUPABASE CLIENT (injected from server.js) ─────────────────────
let _supabase = null;
function setSupabase(client) { _supabase = client; }

// ── SUPABASE TABLE: credits ───────────────────────────────────────
// Columns: api_key (text, primary key), tier (text), credits (int),
//          purchased_credits (int), last_reset (text), created_at (text)

async function dbGet(apiKey) {
  if (!_supabase) return null;
  try {
    const { data, error } = await _supabase
      .from("credits")
      .select("*")
      .eq("api_key", apiKey)
      .single();
    if (error) return null;
    return data;
  } catch(e) { return null; }
}

async function dbSave(apiKey, record) {
  if (!_supabase) return;
  try {
    await _supabase.from("credits").upsert({
      api_key:           apiKey,
      tier:              record.tier,
      credits:           record.credits,
      purchased_credits: record.purchasedCredits,
      last_reset:        record.lastReset,
      created_at:        record.createdAt || new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    }, { onConflict: "api_key" });
  } catch(e) {
    console.error("Credit DB save failed:", e.message);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
}

function currentDayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}

function dbRowToRecord(row) {
  return {
    tier:             row.tier,
    credits:          row.credits,
    purchasedCredits: row.purchased_credits,
    lastReset:        row.last_reset,
    lastDailyDrip:    row.last_daily_drip || null,
    createdAt:        row.created_at,
  };
}

// ── MONTHLY / DAILY RESET ─────────────────────────────────────────
async function checkResets(apiKey, record) {
  const thisMonth = currentMonthKey();
  const today     = currentDayKey();
  let changed     = false;

  // Free tier: 1 credit daily drip
  if (record.tier === "free") {
    if (record.lastDailyDrip !== today && record.credits < 1) {
      record.credits      = 1;
      record.lastDailyDrip = today;
      changed = true;
      console.log(`Free daily drip: 1 credit → ${apiKey}`);
    }
    if (changed) await dbSave(apiKey, record);
    return;
  }

  // Paid tiers: monthly reset
  if (record.lastReset !== thisMonth) {
    const tierConfig    = TIERS[record.tier] || TIERS.free;
    const unused        = Math.max(0, record.credits);
    const rollover      = Math.min(unused, 45);
    record.credits      = rollover + tierConfig.monthlyCredits;
    record.lastReset    = thisMonth;
    changed = true;
    console.log(`Monthly reset ${record.tier}: ${rollover} rolled + ${tierConfig.monthlyCredits} new = ${record.credits}`);
  }

  if (changed) await dbSave(apiKey, record);
}

// ── PUBLIC API ────────────────────────────────────────────────────
async function getUser(apiKey, tier) {
  tier = tier || "free";
  let row = await dbGet(apiKey);

  if (!row) {
    // New user
    const tierConfig   = TIERS[tier] || TIERS.free;
    const startCredits = tierConfig.monthlyCredits || tierConfig.startingCredits || 0;
    const record = {
      tier,
      credits:          startCredits,
      purchasedCredits: 0,
      lastReset:        currentMonthKey(),
      createdAt:        new Date().toISOString(),
    };
    await dbSave(apiKey, record);
    console.log(`New ${tier} user: ${startCredits} credits → ${apiKey}`);
    return record;
  }

  const record = dbRowToRecord(row);

  // Auto-correct tier if key changed
  if (record.tier !== tier) {
    const tierConfig = TIERS[tier] || TIERS.free;
    record.tier = tier;
    if (record.credits < (tierConfig.monthlyCredits || 0)) {
      record.credits = tierConfig.monthlyCredits;
    }
    await dbSave(apiKey, record);
    console.log(`Tier corrected → ${tier} for ${apiKey}`);
  }

  return record;
}

function getTotalCredits(record) {
  return (record.credits || 0) + (record.purchasedCredits || 0);
}

async function getUserStatus(apiKey, tier) {
  const record = await getUser(apiKey, tier);
  await checkResets(apiKey, record);
  const tierConfig = TIERS[record.tier] || TIERS.free;
  return {
    tier:             record.tier,
    tierName:         tierConfig.name,
    credits:          record.credits,
    purchasedCredits: record.purchasedCredits,
    totalCredits:     getTotalCredits(record),
    maxTickers:       tierConfig.maxTickers,
    cacheMinutes:     tierConfig.cacheMinutes,
    features: {
      pulse:    tierConfig.pulse,
      tracker:  tierConfig.tracker,
      glossary: tierConfig.glossary,
      alpaca:   tierConfig.alpaca,
      earnings: tierConfig.earnings,
    },
    lastReset: record.lastReset,
  };
}

async function deductCredit(apiKey, count, tier) {
  const record = await getUser(apiKey, tier);
  await checkResets(apiKey, record);
  const total = getTotalCredits(record);
  if (total < count) return false;

  // Deduct purchased first (never expire), then regular
  let remaining = count;
  if (record.purchasedCredits >= remaining) {
    record.purchasedCredits -= remaining;
  } else {
    remaining -= record.purchasedCredits;
    record.purchasedCredits = 0;
    record.credits -= remaining;
  }
  await dbSave(apiKey, record);
  return true;
}

async function addPurchasedCredits(apiKey, count) {
  const record = await getUser(apiKey);
  record.purchasedCredits = (record.purchasedCredits || 0) + count;
  await dbSave(apiKey, record);
  return getTotalCredits(record);
}

async function upgradeTier(apiKey, newTier) {
  if (!TIERS[newTier]) return false;
  const record     = await getUser(apiKey);
  const tierConfig = TIERS[newTier];
  record.tier      = newTier;
  record.credits   = Math.min(record.credits, 45) + tierConfig.monthlyCredits;
  record.lastReset = currentMonthKey();
  await dbSave(apiKey, record);
  return true;
}

// Legacy sync stubs (no-ops — everything is now async)
function loadCredits() { console.log("Credits: using Supabase backend"); }

module.exports = {
  TIERS,
  setSupabase,
  loadCredits,
  getUser,
  getUserStatus,
  deductCredit,
  addPurchasedCredits,
  upgradeTier,
  getTotalCredits,
};
