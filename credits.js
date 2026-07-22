
// ═══════════════════════════════════════════════════════════════════
// CREDIT SYSTEM — Trade Verdict
// ═══════════════════════════════════════════════════════════════════
// Storage: simple in-memory Map + JSON file on disk for persistence
// In production replace with Supabase when user base grows
// ═══════════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const CREDIT_FILE = path.join(__dirname, "credits.json");

// ── TIER DEFINITIONS ──────────────────────────────────────────────
const TIERS = {
  free: {
    name:          "Free",
    monthlyCredits: 0,          // free tier uses per-analysis deductions only
    maxTickers:    3,
    cacheMinutes:  15,
    pulse:         false,
    tracker:       false,
    glossary:      true,
    alpaca:        false,
    earnings:      false,
    maxRollover:   45,
    startingCredits: 3,         // free tier gets 3 credits to start
  },
  starter: {
    name:          "Starter",
    monthlyCredits: 45,
    maxTickers:    7,
    cacheMinutes:  5,
    pulse:         true,
    tracker:       false,
    glossary:      true,
    alpaca:        false,
    earnings:      false,
    maxRollover:   45,
    price:         9.99,
  },
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
    maxRollover:   45,
    price:         16.99,
  },
  shark: {
    name:          "Shark",
    monthlyCredits: 145,
    maxTickers:    999,
    cacheMinutes:  1,
    pulse:         true,
    tracker:       true,
    glossary:      true,
    alpaca:        true,
    earnings:      true,
    maxRollover:   45,
    price:         39.99,
  },
};

// ── CREDIT STORE ──────────────────────────────────────────────────
let creditStore = {};

function loadCredits() {
  try {
    if (fs.existsSync(CREDIT_FILE)) {
      creditStore = JSON.parse(fs.readFileSync(CREDIT_FILE, "utf8"));
      console.log(`Credit store loaded: ${Object.keys(creditStore).length} users`);
    }
  } catch(e) {
    console.error("Credit store load failed:", e.message);
    creditStore = {};
  }
}

function saveCredits() {
  try {
    fs.writeFileSync(CREDIT_FILE, JSON.stringify(creditStore, null, 2));
  } catch(e) {
    console.error("Credit store save failed:", e.message);
  }
}

// ── USER RECORD ───────────────────────────────────────────────────
// apiKey → { tier, credits, purchasedCredits, lastReset, createdAt }
function getUser(apiKey, tier) {
  tier = tier || "free";
  if (!creditStore[apiKey]) {
    // New user — initialize with correct tier and credits
    const tierConfig = TIERS[tier] || TIERS.free;
    const startCredits = tierConfig.monthlyCredits || tierConfig.startingCredits || 0;
    creditStore[apiKey] = {
      tier:             tier,
      credits:          startCredits,
      purchasedCredits: 0,
      lastReset:        currentMonthKey(),
      createdAt:        new Date().toISOString(),
    };
    console.log(`New ${tier} user initialized with ${startCredits} credits`);
    saveCredits();
  } else if (creditStore[apiKey].tier !== tier) {
    // Key exists but tier mismatch — upgrade/correct the tier
    const tierConfig = TIERS[tier] || TIERS.free;
    creditStore[apiKey].tier = tier;
    // Only top up if current credits are lower than new tier's starting amount
    const minCredits = tierConfig.monthlyCredits || tierConfig.startingCredits || 0;
    if (creditStore[apiKey].credits < minCredits) {
      creditStore[apiKey].credits = minCredits;
    }
    console.log(`User tier corrected to ${tier}`);
    saveCredits();
  }
  return creditStore[apiKey];
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
}

// ── MONTHLY RESET ─────────────────────────────────────────────────
// Called on every request — checks if a new month has started
function currentDayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}

function checkMonthlyReset(user) {
  const thisMonth = currentMonthKey();
  const today     = currentDayKey();

  // ── FREE TIER: 1 credit per day drip ─────────────────────────
  if (user.tier === "free") {
    if (user.lastDailyDrip !== today && user.credits < 1) {
      user.credits      = 1; // drip exactly 1 credit per day
      user.lastDailyDrip = today;
      console.log(`Free tier daily drip: 1 credit added`);
      saveCredits();
    }
    return; // free tier does not get monthly reset
  }

  // ── PAID TIERS: monthly reset ─────────────────────────────────
  if (user.lastReset === thisMonth) return;

  const tier = TIERS[user.tier] || TIERS.free;

  // Roll over unused credits — capped at 45 across all tiers
  const unusedCredits = Math.max(0, user.credits);
  const rollover      = Math.min(unusedCredits, 45);

  // New balance = rollover + monthly allowance
  user.credits   = rollover + tier.monthlyCredits;
  user.lastReset = thisMonth;

  console.log(`Monthly reset for ${user.tier} user: ${rollover} rolled + ${tier.monthlyCredits} new = ${user.credits} credits`);
  saveCredits();
}

// ── CREDIT OPERATIONS ─────────────────────────────────────────────
function getTotalCredits(user) {
  return (user.credits || 0) + (user.purchasedCredits || 0);
}

function deductCredit(apiKey, count = 1, tier) {
  const user = getUser(apiKey, tier);
  checkMonthlyReset(user);

  const total = getTotalCredits(user);
  if (total < count) return false; // insufficient credits

  // Deduct from purchased credits first (they never expire)
  // then from regular credits
  let remaining = count;
  if (user.purchasedCredits >= remaining) {
    user.purchasedCredits -= remaining;
  } else {
    remaining -= user.purchasedCredits;
    user.purchasedCredits = 0;
    user.credits -= remaining;
  }

  saveCredits();
  return true;
}

function addPurchasedCredits(apiKey, count) {
  const user = getUser(apiKey);
  user.purchasedCredits = (user.purchasedCredits || 0) + count;
  saveCredits();
  return getTotalCredits(user);
}

function upgradeTier(apiKey, newTier) {
  if (!TIERS[newTier]) return false;
  const user = getUser(apiKey);
  user.tier  = newTier;
  // Immediately give this month's credits on upgrade
  const tier = TIERS[newTier];
  user.credits   = Math.min(user.credits, 45) + tier.monthlyCredits;
  user.lastReset = currentMonthKey();
  saveCredits();
  return true;
}

function getUserStatus(apiKey, tier) {
  const user = getUser(apiKey, tier);
  checkMonthlyReset(user);
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
      earnings: tierConfig.earnings,
    },
    lastReset: user.lastReset,
  };
}

module.exports = {
  TIERS,
  loadCredits,
  getUser,
  getUserStatus,
  deductCredit,
  addPurchasedCredits,
  upgradeTier,
  getTotalCredits,
};
