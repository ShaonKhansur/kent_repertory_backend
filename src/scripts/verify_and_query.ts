#!/usr/bin/env node
/**
 * src/scripts/verify_and_query.ts
 * 
 * Standalone Test and Diagnostic Runner for the Kent Repertory system (Zero Ollama).
 * Modes:
 *   1. Pre-flight health and LanceDB check (--check)
 *   2. Live Express HTTP API runner (--api)
 *   3. Direct in-process TypeScript Service runner
 */

import { CONFIG } from "../config/env.config.js";
import { DatasetService } from "../services/dataset.service.js";
import { LocalEmbeddingService } from "../services/embed.service.js";
import { LanceDBService } from "../services/lancedb.service.js";
import { ClinicalService } from "../services/clinical.service.js";
import { RepertorizationService } from "../services/repertorization.service.js";

async function runCheck() {
  console.log("=== Kent Repertory Pre-Flight Diagnostic (Zero-Ollama) ===");

  const dataset = DatasetService.getInstance();
  let datasetOk = false;
  let count = 0;
  try {
    await dataset.ensureLoaded();
    count = dataset.getTotalRubricsCount();
    datasetOk = count > 1000;
  } catch (err) {
    console.error("Dataset load error:", err);
  }

  console.log(`- Dataset present:         ${datasetOk ? "✅ YES" : "❌ NO"}`);
  console.log(`  (Total Atomic Rubrics:   ${count.toLocaleString()})`);

  const embedService = LocalEmbeddingService.getInstance();
  const embedOk = await embedService.isReady();
  console.log(`- In-Process Embedder:     ${embedOk ? "✅ YES" : "❌ NO"} (${embedService.modelName}, 768 dims, Node.js ONNX)`);

  const lance = LanceDBService.getInstance();
  const lanceOk = await lance.isReady();
  const lanceCount = await lance.getRecordCount();
  console.log(`- LanceDB Vector DB:       ${lanceOk ? "✅ YES" : "❌ NO"} (${lanceCount.toLocaleString()} rubrics indexed at ${CONFIG.lanceDbDir})`);

  if (datasetOk && embedOk && lanceOk) {
    console.log("\n✅ All pre-flight checks passed successfully! (Zero Ollama required)\n");
  } else {
    console.log("\n❌ Pre-flight checks failed. Please check the logs above.\n");
    process.exit(1);
  }
}

async function runApiMode(query: string, chapter: string, topK: number, baseUrl = "http://localhost:3000") {
  console.log(`\n=== Testing Live Express REST API at ${baseUrl} ===`);

  // 1. Health
  console.log(`\n[1/4] GET ${baseUrl}/api/health ...`);
  const healthRes = await fetch(`${baseUrl}/api/health`);
  const health = await healthRes.json();
  console.log(`Health Status: ${healthRes.status} | Response:`, JSON.stringify(health, null, 2));

  // 2. Search
  console.log(`\n[2/4] POST ${baseUrl}/api/search ...`);
  const searchRes = await fetch(`${baseUrl}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, chapters: [chapter], topK }),
  });
  const searchData = (await searchRes.json()) as any;
  console.log(`Search Status: ${searchRes.status} | Found: ${searchData.count} rubrics`);

  if (!searchData.rubrics || searchData.rubrics.length === 0) {
    console.log("No rubrics returned.");
    return;
  }

  const top = searchData.rubrics[0];
  console.log(`Top Match: [${top.id}] ${top.rubric_path} (Page: ${top.page}, Depth: ${top.depth})`);
  console.log(`Remedies (${top.remedy_count}):`, top.remedies.map((r: any) => `${r.abbr} [Grade ${r.grade}]`).join(", "));
  console.log(`Sub-rubrics: [${top.immediate_child_rubrics.join(", ") || "Leaf rubric"}]`);

  // 3. Clarify
  console.log(`\n[3/4] POST ${baseUrl}/api/clarify ...`);
  const clarifyRes = await fetch(`${baseUrl}/api/clarify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rubric_id: top.id, rubric_path: top.rubric_path }),
  });
  const clarifyData = (await clarifyRes.json()) as any;
  console.log(`Clarify Context: ${clarifyData.rubric_path} [Page ${clarifyData.page}]`);
  console.log(`\nClarifying Questions:\n${clarifyData.clarifying_questions}\n`);

  // 4. Repertorize
  console.log(`\n[4/4] POST ${baseUrl}/api/repertorize ...`);
  const rubricIds = searchData.rubrics.map((r: any) => r.id);
  const repRes = await fetch(`${baseUrl}/api/repertorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rubric_ids: rubricIds }),
  });
  const repData = (await repRes.json()) as any;
  console.log(`Analyzed ${repData.rubrics_analyzed} rubrics. Top Ranked Remedies:`);
  console.table(
    repData.ranked_remedies.slice(0, 10).map((rem: any) => ({
      Rank: rem.rank,
      Name: rem.full_name,
      Abbr: rem.abbr,
      Covered: `${rem.rubrics_covered}/${repData.rubrics_analyzed}`,
      Score: rem.total_score,
    }))
  );
}

async function runDirectServiceMode(query: string, chapter: string, topK: number) {
  console.log(`\n=== Running Direct LanceDB Vector Search (In-Process) ===`);
  console.log(`Query: "${query}" | Chapter: "${chapter}" | TopK: ${topK}\n`);

  const lance = LanceDBService.getInstance();
  const isReady = await lance.isReady();

  if (!isReady) {
    console.error("LanceDB is not ready. Please run: npm run ingest:lancedb");
    process.exit(1);
  }

  const embedService = LocalEmbeddingService.getInstance();
  const queryVec = await embedService.embedQuery(query);
  const results = await lance.search({
    query,
    queryVector: queryVec,
    chapters: [chapter],
    topK,
  });

  console.log(`\n--- Matched Rubrics via LanceDB (${results.length}) ---`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`\n[Match ${i + 1}] (Score: ${r.similarity_score.toFixed(4)})`);
    console.log(`  Rubric:      ${r.rubric_path}`);
    console.log(`  Page:        ${r.page} | Author: ${r.author}`);
    console.log(`  Remedies:    ${r.remedy_count} remedies`);
    console.log(`  Key Remedies: ${r.remedies.slice(0, 6).map((rem) => `${rem.abbr} (${rem.grade})`).join(", ")}`);
    if (r.immediate_child_rubrics.length > 0) {
      console.log(`  Sub-rubrics: [${r.immediate_child_rubrics.join(", ")}]`);
    } else {
      console.log(`  Sub-rubrics: None (Leaf rubric).`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--check")) {
    await runCheck();
    return;
  }

  let query = "forsaken feeling in the evening";
  let chapter = "Mind";
  let topK = 5;
  const isApi = args.includes("--api");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--query" && args[i + 1]) query = args[++i];
    if (args[i] === "--chapter" && args[i + 1]) chapter = args[++i];
    if (args[i] === "--topK" && args[i + 1]) topK = parseInt(args[++i], 10);
  }

  if (isApi) {
    await runApiMode(query, chapter, topK);
  } else {
    await runDirectServiceMode(query, chapter, topK);
  }
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
