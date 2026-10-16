#!/usr/bin/env node
/**
 * src/scripts/ingest_supabase.ts
 * 
 * High-speed batch ingestion script from local LanceDB / JSONL into Supabase pgvector.
 * Uploads rubrics with 768-dim vector embeddings, remedies, page numbers, and modalities.
 * 
 * Usage:
 *   npx tsx src/scripts/ingest_supabase.ts
 */

import { CONFIG } from "../config/env.config.js";
import { LanceDBService, LanceRubricRow } from "./../services/lancedb.service.js";
import { SupabaseService } from "../services/supabase.service.js";
import { LocalEmbeddingService } from "../services/embed.service.js";

async function main() {
  console.log("===============================================================");
  console.log("     Kent's Repertory -> Supabase (pgvector) Batch Ingestion    ");
  console.log("===============================================================\n");

  const startTime = Date.now();

  // 1. Verify Supabase connection
  console.log("[1/4] Verifying Supabase connection...");
  const supabaseService = SupabaseService.getInstance();
  const client = supabaseService.getClient();

  const { error: testErr } = await client.from("rubrics").select("id").limit(1);
  if (testErr) {
    console.error("❌ Failed to query Supabase:", testErr.message);
    process.exit(1);
  }
  console.log("  -> Supabase 'rubrics' table is ready.\n");

  // 2. Connect to local LanceDB
  console.log("[2/4] Reading pre-indexed rubrics from local LanceDB...");
  const lanceService = LanceDBService.getInstance();
  const lanceReady = await lanceService.isReady();

  if (!lanceReady) {
    console.error("❌ Local LanceDB table not found. Please ensure kent_lancedb exists.");
    process.exit(1);
  }

  const lanceCount = await lanceService.getRecordCount();
  console.log(`  -> Found ${lanceCount.toLocaleString()} indexed vector records in local LanceDB.\n`);

  // Access the lance table directly to stream rows
  const db = (lanceService as any).db;
  const table = (lanceService as any).table;
  const allRows = (await table.query().toArray()) as LanceRubricRow[];

  const existingCount = await supabaseService.getRecordCount();
  console.log(`  -> Existing records in Supabase: ${existingCount.toLocaleString()}`);

  const rowsToUpload = existingCount > 0 ? allRows.slice(existingCount) : allRows;
  console.log(`[3/4] Uploading ${rowsToUpload.length.toLocaleString()} remaining rubrics to Supabase (batch size 100)...`);

  const BATCH_SIZE = 100; // Safe batch size to prevent Supabase 8-second statement timeout
  let totalUploaded = existingCount;

  for (let i = 0; i < rowsToUpload.length; i += BATCH_SIZE) {
    const chunk = rowsToUpload.slice(i, i + BATCH_SIZE);

    const formattedRows = chunk.map((r) => {
      let remedies = [];
      try {
        remedies = JSON.parse(r.remedies_json || "[]");
      } catch {
        remedies = [];
      }

      let immediate_child_rubrics = [];
      try {
        immediate_child_rubrics = JSON.parse(r.immediate_children_json || "[]");
      } catch {
        immediate_child_rubrics = [];
      }

      return {
        id: r.id,
        rubric_path: r.rubric_path,
        rubric_label: r.rubric_label,
        chapter: r.chapter,
        page: r.page,
        author: r.author || "J.T. Kent",
        source_url: r.source_url || "",
        depth: r.depth,
        remedy_count: r.remedy_count,
        remedies,
        immediate_child_rubrics,
        embedding: r.vector,
      };
    });

    let success = false;
    let attempts = 0;
    while (!success && attempts < 3) {
      attempts++;
      const { error: upsertErr } = await client
        .from("rubrics")
        .upsert(formattedRows, { onConflict: "id" });

      if (upsertErr) {
        if (attempts >= 3) {
          console.error(`\n❌ Error upserting batch at offset ${existingCount + i}:`, upsertErr.message);
          throw upsertErr;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      } else {
        success = true;
      }
    }

    totalUploaded += chunk.length;
    const pct = ((totalUploaded / allRows.length) * 100).toFixed(1);
    process.stdout.write(`\r  -> Progress: ${totalUploaded.toLocaleString()} / ${allRows.length.toLocaleString()} (${pct}%)`);
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n✅ Upload complete! Successfully ingested ${totalUploaded.toLocaleString()} rubrics in ${totalElapsed}s.`);

  // 4. Benchmark live Supabase vector search
  console.log("\n[4/4] Testing Live Supabase Vector Search...");
  const sampleQuery = "forsaken feeling in the evening";
  const embedService = LocalEmbeddingService.getInstance();
  const queryVec = await embedService.embedQuery(sampleQuery);

  const tSearchStart = Date.now();
  const matches = await supabaseService.search({
    query: sampleQuery,
    queryVector: queryVec,
    chapters: ["Mind"],
    topK: 5,
  });
  const searchElapsed = Date.now() - tSearchStart;

  console.log(`  Query:                 "${sampleQuery}" [Mind]`);
  console.log(`  Supabase Vector Latency: ${searchElapsed}ms (via match_rubrics RPC)`);
  console.log(`  Results Found:          ${matches.length}`);

  if (matches.length > 0) {
    const top = matches[0];
    console.log(`  Top Match:              ${top.rubric_path} (Page ${top.page})`);
    console.log(`  Similarity Score:       ${top.similarity_score}`);
    console.log(`  Key Remedies:           ${top.remedies.slice(0, 5).map((r) => `${r.abbr} (${r.grade})`).join(", ")}`);
  }

  console.log("\n🎉 Supabase is fully configured and ready for production!\n");
}

main().catch((err) => {
  console.error("Fatal ingestion error:", err);
  process.exit(1);
});
