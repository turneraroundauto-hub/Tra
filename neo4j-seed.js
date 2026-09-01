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
];

const RELATIONSHIPS = [
  { from: "TSMC", to: "NVIDIA",            relationship_type: "supplies",               direction: "directed", source: "seed" },
  { from: "TSMC", to: "AMD",               relationship_type: "supplies",               direction: "directed", source: "seed" },
  { from: "TSMC", to: "APPLE",             relationship_type: "supplies",               direction: "directed", source: "seed" },
  { from: "TSMC", to: "ASML",              relationship_type: "buys_equipment_from",    direction: "directed", source: "seed" },
  { from: "TSMC", to: "APPLIED_MATERIALS", relationship_type: "buys_equipment_from",    direction: "directed", source: "seed" },
  { from: "TSMC", to: "SAMSUNG",           relationship_type: "competes_with",          direction: "mutual",   source: "seed" },
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

  console.log("\nVerifying — TSMC's relationships as read back from Neo4j:");
  const tsmcRelationships = await kg.getCompanyRelationships("TSM");
  for (const r of tsmcRelationships) {
    console.log(`  ${r.direction === "outgoing" ? "→" : "←"} ${r.relationship_type} ${r.name} (${r.ticker || "no ticker"})`);
  }

  const expectedCount = RELATIONSHIPS.length;
  if (tsmcRelationships.length !== expectedCount) {
    console.error(`WARNING: expected ${expectedCount} relationships for TSMC, found ${tsmcRelationships.length}`);
  } else {
    console.log(`\nOK — all ${expectedCount} relationships confirmed round-trip through Neo4j.`);
  }

  await kg.closeDriver();
}

main().catch(e => {
  console.error("Seed failed:", e.message);
  process.exit(1);
});
