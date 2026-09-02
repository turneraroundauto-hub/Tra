// ═══════════════════════════════════════════════════════════════
// Company/Industry Knowledge Graph — Phase 1 proof-of-concept seed
// ═══════════════════════════════════════════════════════════════
// Standalone script, not loaded by server.js — run by hand once Neo4j
// credentials are set (`node neo4j-seed.js`) to prove the Phase 1
// plumbing (neo4j-graph.js) end-to-end against the exact example from
// the original design conversation:
//
//   TSMC
//    ├── supplies → NVIDIA
//    ├── supplies → AMD
//    ├── supplies → Apple
//    ├── buys equipment from → ASML
//    ├── buys equipment from → Applied Materials
//    └── competes with → Samsung
//
// Real seed data (a small, hand-curated starting set), not a placeholder
// — but deliberately small in scope for Phase 1: proving the graph shape
// works, not attempting real market-wide coverage yet. Safe to re-run
// (every upsert is a Neo4j MERGE) — running this twice does not create
// duplicate nodes or edges.

const kg = require("./neo4j-graph");

const COMPANIES = [
  { company_id: "TSMC",              name: "Taiwan Semiconductor Manufacturing Company", country: "Taiwan",       industry: "Semiconductors",        ticker: "TSM",  exchange: "NYSE" },
  { company_id: "NVIDIA",            name: "NVIDIA Corporation",                          country: "United States", industry: "Semiconductors",        ticker: "NVDA", exchange: "NASDAQ" },
  { company_id: "AMD",               name: "Advanced Micro Devices, Inc.",                country: "United States", industry: "Semiconductors",        ticker: "AMD",  exchange: "NASDAQ" },
  { company_id: "APPLE",             name: "Apple Inc.",                                  country: "United States", industry: "Consumer Electronics",  ticker: "AAPL", exchange: "NASDAQ" },
  { company_id: "ASML",              name: "ASML Holding N.V.",                           country: "Netherlands",  industry: "Semiconductor Equipment", ticker: "ASML", exchange: "NASDAQ" },
  { company_id: "APPLIED_MATERIALS", name: "Applied Materials, Inc.",                     country: "United States", industry: "Semiconductor Equipment", ticker: "AMAT", exchange: "NASDAQ" },
  { company_id: "SAMSUNG",           name: "Samsung Electronics Co., Ltd.",               country: "South Korea",  industry: "Semiconductors",        ticker: null,   exchange: null },

  // ── Automotive/embedded-OS cluster (Sep 1, 2026) ───────────────────
  // Real, hand-researched second cluster -- added specifically because
  // the graph had zero coverage for a live-reported query ("Qnx
  // automotive iot"), and Finnhub's own /stock/peers came back empty
  // for BB with no real fallback. Same discipline as the TSMC cluster
  // above: small, deliberately conservative, only well-documented, easily
  // verifiable public facts -- not a speculative broad guess at "every
  // company in automotive software."
  { company_id: "BLACKBERRY", name: "BlackBerry Limited",    country: "Canada",        industry: "Automotive Software", ticker: "BB",   exchange: "NYSE" },
  { company_id: "APTIV",      name: "Aptiv PLC",             country: "Ireland",       industry: "Automotive Technology", ticker: "APTV", exchange: "NYSE" },
  // Wind River Systems is a real company (VxWorks, a direct QNX
  // real-time-OS competitor) but not independently public -- Aptiv
  // acquired it in 2022, a real, well-documented transaction. ticker:null
  // is the deliberate, schema-supported way to represent a real,
  // privately-held entity (see the design comment in neo4j-graph.js).
  { company_id: "WIND_RIVER", name: "Wind River Systems",   country: "United States", industry: "Embedded Software",    ticker: null,   exchange: null },
  { company_id: "FORD",       name: "Ford Motor Company",   country: "United States", industry: "Automotive",           ticker: "F",    exchange: "NYSE" },
  { company_id: "QUALCOMM",   name: "Qualcomm Incorporated", country: "United States", industry: "Semiconductors",       ticker: "QCOM", exchange: "NASDAQ" },
];

const RELATIONSHIPS = [
  { from: "TSMC", to: "NVIDIA",            relationship_type: "supplies",               direction: "directed", source: "seed" },
  { from: "TSMC", to: "AMD",               relationship_type: "supplies",               direction: "directed", source: "seed" },
  { from: "TSMC", to: "APPLE",             relationship_type: "supplies",               direction: "directed", source: "seed" },
  { from: "TSMC", to: "ASML",              relationship_type: "buys_equipment_from",    direction: "directed", source: "seed" },
  { from: "TSMC", to: "APPLIED_MATERIALS", relationship_type: "buys_equipment_from",    direction: "directed", source: "seed" },
  { from: "TSMC", to: "SAMSUNG",           relationship_type: "competes_with",          direction: "mutual",   source: "seed" },

  // Automotive/embedded-OS cluster -- see the COMPANIES comment above.
  { from: "WIND_RIVER",  to: "APTIV",      relationship_type: "subsidiary_of", direction: "directed", source: "seed (Aptiv acquired Wind River, 2022)" },
  { from: "BLACKBERRY",  to: "WIND_RIVER", relationship_type: "competes_with", direction: "mutual",   source: "seed (QNX vs. VxWorks, automotive/embedded real-time OS)" },
  { from: "BLACKBERRY",  to: "QUALCOMM",   relationship_type: "competes_with", direction: "mutual",   source: "seed (QNX vs. Snapdragon Digital Chassis, software-defined vehicle platforms)" },
  { from: "BLACKBERRY",  to: "FORD",       relationship_type: "supplies",     direction: "directed", source: "seed (BlackBerry QNX / Ford software partnership, announced 2023)" },
];

async function main() {
  if (!kg.isConfigured()) {
    console.error("NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD not set — nothing to seed. Set them and re-run.");
    process.exit(1);
  }

  console.log("Ensuring schema (constraints/indexes)...");
  const schemaResult = await kg.ensureSchema();
  if (!schemaResult.ok) {
    console.error("Schema setup failed:", schemaResult.reason);
    process.exit(1);
  }

  console.log(`Upserting ${COMPANIES.length} companies...`);
  for (const company of COMPANIES) {
    await kg.upsertCompany(company);
    console.log(`  ${company.company_id} (${company.ticker || "no ticker"})`);
  }

  console.log(`Upserting ${RELATIONSHIPS.length} relationships...`);
  for (const rel of RELATIONSHIPS) {
    await kg.upsertRelationship(rel.from, rel.to, rel);
    console.log(`  ${rel.from} -[${rel.relationship_type}]-> ${rel.to}`);
  }

  // Verify each cluster independently -- checking one company's total
  // relationship count against RELATIONSHIPS.length (the ORIGINAL check)
  // only ever worked because every relationship touched TSMC; now that a
  // second, unrelated cluster exists, that comparison would be silently
  // wrong (TSMC's own real count is still 6, not the array's new total).
  async function verifyCluster(ticker, expectedCount) {
    console.log(`\nVerifying — ${ticker}'s relationships as read back from Neo4j:`);
    const rels = await kg.getCompanyRelationships(ticker);
    for (const r of rels) {
      console.log(`  ${r.direction === "outgoing" ? "→" : "←"} ${r.relationship_type} ${r.name} (${r.ticker || "no ticker"})`);
    }
    if (rels.length !== expectedCount) {
      console.error(`WARNING: expected ${expectedCount} relationships for ${ticker}, found ${rels.length}`);
    } else {
      console.log(`OK — all ${expectedCount} relationships confirmed round-trip through Neo4j.`);
    }
  }

  await verifyCluster("TSM", 6);
  await verifyCluster("BB", 3); // WIND_RIVER, QUALCOMM (competes_with) + FORD (supplies)

  await kg.closeDriver();
}

main().catch(e => {
  console.error("Seed failed:", e.message);
  process.exit(1);
});
