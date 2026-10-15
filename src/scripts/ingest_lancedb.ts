#!/usr/bin/env node
/**
 * src/scripts/ingest_lancedb.ts
 * 
 * Local LanceDB ingestion script for J.T. Kent's Repertory.
 * 
 * Features:
 *  - High-speed vector ingestion into local LanceDB (Apache Arrow columnar format)
 *  - Fast-path reuse of pre-calculated vectors from kent_vector_cache/ (61,500+ vectors in seconds)
 *  - Dynamic batch embedding via Ollama nomic-embed-text for any missing chapters
 *  - Stores atomic rubrics with exact page numbers, author, URLs, graded remedies, and child rubrics
 *  - Benchmarks vector retrieval speed post-ingest (< 10ms target)
 * 
 * Usage:
 *  npx tsx src/scripts/ingest_lancedb.ts
 *  npx tsx src/scripts/ingest_lancedb.ts --skip-missing
 */

import fs from "fs";
import path from "path";
import * as lancedb from "@lancedb/lancedb";
import { CONFIG } from "../config/env.config.js";
import { DatasetService } from "../services/dataset.service.js";
import { LocalEmbeddingService } from "../services/embed.service.js";
import { LanceRubricRow } from "../services/lancedb.service.js";

async function main() {
  const args = process.argv.slice(2);
  const skipMissing = args.includes("--skip-missing");

  console.log("===============================================================");
  console.log("       Kent's Repertory -> Local LanceDB Vector Ingestion       ");
  console.log("===============================================================\n");

  const startTime = Date.now();

  // 1. Ensure dataset is loaded
  console.log("[1/5] Loading Kent Repertory full dataset (78,926 atomic rubrics)...");
  const dataset = DatasetService.getInstance();
  await dataset.ensureLoaded();
  const allDocs = dataset.getDocumentsForChapter(null);
  console.log(`  -> Loaded ${allDocs.length} rubrics across ${dataset.getAvailableChapters().length} chapters.\n`);

  // 2. Scan and load pre-calculated vectors from kent_vector_cache
  console.log("[2/5] Scanning local vector cache for pre-calculated embeddings...");
  const vectorMap = new Map<string, number[]>();

  if (fs.existsSync(CONFIG.vectorCacheDir)) {
    const cacheFiles = fs
      .readdirSync(CONFIG.vectorCacheDir)
      .filter((f) => f.startsWith("kent_") && f.endsWith("_vectors.json"));

    console.log(`  -> Found ${cacheFiles.length} chapter cache files in ${CONFIG.vectorCacheDir}`);

    for (const file of cacheFiles) {
      try {
        const filePath = path.join(CONFIG.vectorCacheDir, file);
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.documents) && Array.isArray(data.vectors)) {
          const count = Math.min(data.documents.length, data.vectors.length);
          for (let i = 0; i < count; i++) {
            const doc = data.documents[i];
            const vec = data.vectors[i];
            if (doc && doc.metadata && doc.metadata.id && vec) {
              vectorMap.set(doc.metadata.id, vec);
            }
          }
        }
      } catch (err) {
        console.warn(`  Warning: Could not read ${file}:`, err);
      }
    }
  }

  console.log(`  -> Loaded ${vectorMap.size} pre-computed vectors instantly from cache!\n`);

  // 3. Identify missing vectors
  const missingDocs = allDocs.filter((d) => !vectorMap.has(d.metadata.id));
  console.log(`[3/5] Vector coverage analysis:`);
  console.log(`  - Covered vectors: ${vectorMap.size} / ${allDocs.length} (${((vectorMap.size / allDocs.length) * 100).toFixed(1)}%)`);
  console.log(`  - Missing vectors: ${missingDocs.length}`);

  if (missingDocs.length > 0 && !skipMissing) {
    console.log(`\n  Initializing in-process neural embedder (Zero Ollama)...`);
    try {
      const embeddings = LocalEmbeddingService.getInstance();

      // Group missing docs by chapter for incremental saving
      const missingByChapter = new Map<string, typeof missingDocs>();
      for (const doc of missingDocs) {
        const ch = doc.metadata.chapter || "other";
        if (!missingByChapter.has(ch)) missingByChapter.set(ch, []);
        missingByChapter.get(ch)!.push(doc);
      }

      console.log(`  Embedding ${missingDocs.length} rubrics across ${missingByChapter.size} chapter(s)...`);

      for (const [ch, docs] of missingByChapter) {
        console.log(`\n  --- Embedding Chapter: ${ch} (${docs.length} rubrics) ---`);
        const batchSize = CONFIG.batchSize;
        const chVectors: number[][] = [];
        const chDocs = docs;

        for (let i = 0; i < docs.length; i += batchSize) {
          const batch = docs.slice(i, i + batchSize);
          const texts = batch.map((d) => d.pageContent);
          const batchVecs = await embeddings.embedDocuments(texts);

          for (let j = 0; j < batch.length; j++) {
            vectorMap.set(batch[j].metadata.id, batchVecs[j]);
            chVectors.push(batchVecs[j]);
          }

          const done = Math.min(i + batchSize, docs.length);
          const pct = ((done / docs.length) * 100).toFixed(1);
          process.stdout.write(`\r    [${ch}] Embedded ${done}/${docs.length} (${pct}%)`);
        }

        if (fs.existsSync(CONFIG.vectorCacheDir)) {
          console.log(`\n    Saving ${ch} embeddings to cache...`);
          const safeKey = ch.toLowerCase().replace(/[^a-z0-9]/g, "_");
          const cacheFile = path.join(CONFIG.vectorCacheDir, `kent_${safeKey}_vectors.json`);
          fs.writeFileSync(
            cacheFile,
            JSON.stringify({
              chapter: ch,
              count: chDocs.length,
              created_at: new Date().toISOString(),
              documents: chDocs.map((d) => ({
                pageContent: d.pageContent,
                metadata: d.metadata,
              })),
              vectors: chVectors,
            })
          );
        }
      }
    } catch (err) {
      console.warn("\n  ⚠️ Could not embed missing rubrics:", (err as Error).message);
      console.log("  Proceeding with all currently available vectors into LanceDB.");
    }
  } else if (missingDocs.length > 0 && skipMissing) {
    console.log("  (--skip-missing specified: ingesting available vectors without generating new ones)");
  }

  // 4. Prepare LanceDB rows
  console.log("\n[4/5] Preparing LanceDB records with rich homeopathic metadata...");
  const rowsToInsert: LanceRubricRow[] = [];

  for (const doc of allDocs) {
    const meta = doc.metadata;
    const vec = vectorMap.get(meta.id);
    if (!vec) continue; // Only insert records with valid vectors

    const children = dataset.getImmediateChildren(meta.rubric_path, meta.depth);

    rowsToInsert.push({
      id: meta.id,
      rubric_path: meta.rubric_path,
      rubric_label: meta.rubric_label,
      chapter: meta.chapter,
      page: meta.page,
      author: meta.author || "J.T. Kent",
      source_url: meta.source_url || "",
      depth: meta.depth,
      remedy_count: meta.remedy_count,
      remedies_json: JSON.stringify(meta.remedies || []),
      immediate_children_json: JSON.stringify(children.map((c) => c.rubric_label)),
      embedding_text: doc.pageContent,
      vector: vec,
    });
  }

  console.log(`  -> Prepared ${rowsToInsert.length} complete vector records.`);

  // 5. Connect and write to LanceDB
  console.log(`\n[5/5] Ingesting into LanceDB at '${CONFIG.lanceDbDir}'...`);
  if (!fs.existsSync(CONFIG.lanceDbDir)) {
    fs.mkdirSync(CONFIG.lanceDbDir, { recursive: true });
  }

  const db = await lancedb.connect(CONFIG.lanceDbDir);

  // Ingest in batches to conserve peak memory
  const INGEST_CHUNK_SIZE = 10000;
  let table: lancedb.Table;

  const firstChunk = rowsToInsert.slice(0, INGEST_CHUNK_SIZE);
  console.log(`  -> Creating table '${CONFIG.lanceTableName}' with initial ${firstChunk.length} records...`);
  table = await db.createTable(CONFIG.lanceTableName, firstChunk, { mode: "overwrite" });

  for (let i = INGEST_CHUNK_SIZE; i < rowsToInsert.length; i += INGEST_CHUNK_SIZE) {
    const chunk = rowsToInsert.slice(i, i + INGEST_CHUNK_SIZE);
    await table.add(chunk);
    console.log(`  -> Appended batch ${i} - ${i + chunk.length} records...`);
  }

  const finalCount = await table.countRows();
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("\n===============================================================");
  console.log("               LanceDB Ingestion Complete!                    ");
  console.log("===============================================================");
  console.log(`  - Database Path:       ${CONFIG.lanceDbDir}`);
  console.log(`  - Table Name:          ${CONFIG.lanceTableName}`);
  console.log(`  - Total Rows Ingested: ${finalCount.toLocaleString()} rubrics`);
  console.log(`  - Time Elapsed:        ${totalElapsed}s`);

  // Run benchmark search
  console.log("\n--- Benchmarking Vector Retrieval Speed ---");
  const sampleQuery = "forsaken feeling in the evening";
  const embeddings = LocalEmbeddingService.getInstance();

  try {
    const qVecStart = Date.now();
    const queryVec = await embeddings.embedQuery(sampleQuery);
    const qVecElapsed = Date.now() - qVecStart;

    const tSearchStart = Date.now();
    const matches = await table
      .vectorSearch(queryVec)
      .distanceType("cosine")
      .where("chapter = 'Mind'")
      .limit(5)
      .toArray();
    const searchElapsed = Date.now() - tSearchStart;

    console.log(`  Query:                  "${sampleQuery}" [Mind]`);
    console.log(`  In-Process embed time:  ${qVecElapsed}ms (Zero-Ollama)`);
    console.log(`  LanceDB vector search:  ${searchElapsed}ms ⚡ (Target: < 10ms)`);
    console.log(`  Top match:              ${matches[0]?.rubric_path} (Page ${matches[0]?.page})`);
  } catch (err) {
    console.log("  Benchmark note:", (err as Error).message);
  }

  console.log("\n✅ Ready for high-speed local LanceDB queries!\n");
}

main().catch((err) => {
  console.error("Fatal ingestion error:", err);
  process.exit(1);
});
