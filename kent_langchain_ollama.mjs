#!/usr/bin/env node
/**
 * kent_langchain_ollama.mjs
 * 
 * Local LangChain.js + Ollama RAG clinical assistant for J.T. Kent's Repertory.
 * Features:
 *  - Persistent local vector store with OllamaEmbeddings (nomic-embed-text)
 *  - Atomic Document mapping from kent_repertory_full.jsonl (No text splitters)
 *  - Child sub-rubric clinical questioning via ChatOllama (llama3.2)
 *  - Deterministic remedy repertorization math
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { Document } from "@langchain/core/documents";
import { OllamaEmbeddings, ChatOllama } from "@langchain/ollama";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration constants
export const CONFIG = {
  jsonlPath: path.resolve(__dirname, "kent_output", "kent_repertory_full.jsonl"),
  vectorCacheDir: path.resolve(__dirname, "kent_vector_cache"),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  embeddingModel: process.env.EMBEDDING_MODEL || "nomic-embed-text",
  chatModel: process.env.CHAT_MODEL || "llama3.2",
  batchSize: 64,
};

/**
 * Perform pre-flight environment check.
 * Verifies dataset file and local Ollama service + models.
 */
export async function checkEnvironment() {
  const report = {
    dataset: false,
    ollama: false,
    embeddingModel: false,
    chatModel: false,
    modelsAvailable: [],
    errors: [],
  };

  // 1. Check Dataset
  try {
    if (fs.existsSync(CONFIG.jsonlPath)) {
      const stats = fs.statSync(CONFIG.jsonlPath);
      if (stats.size > 1000) {
        report.dataset = true;
        report.datasetSizeBytes = stats.size;
      } else {
        report.errors.push(`Dataset ${CONFIG.jsonlPath} is too small (${stats.size} bytes).`);
      }
    } else {
      report.errors.push(`Dataset not found at ${CONFIG.jsonlPath}`);
    }
  } catch (err) {
    report.errors.push(`Error accessing dataset: ${err.message}`);
  }

  // 2. Check Ollama Service
  try {
    const res = await fetch(`${CONFIG.ollamaBaseUrl}/api/tags`);
    if (res.ok) {
      report.ollama = true;
      const data = await res.json();
      const models = data.models || [];
      report.modelsAvailable = models.map((m) => m.name);

      const hasEmbedding = models.some(
        (m) => m.name.includes("nomic-embed-text")
      );
      const hasChat = models.some(
        (m) => m.name.includes("llama3.2") || m.name.includes("qwen2.5")
      );

      report.embeddingModel = hasEmbedding;
      report.chatModel = hasChat;

      if (!hasEmbedding) {
        report.errors.push(`Missing embedding model 'nomic-embed-text'. Run: ollama pull nomic-embed-text`);
      }
      if (!hasChat) {
        report.errors.push(`Missing chat model 'llama3.2'. Run: ollama pull llama3.2`);
      }
    } else {
      report.errors.push(`Ollama responded with HTTP ${res.status}`);
    }
  } catch (err) {
    report.errors.push(`Could not connect to Ollama at ${CONFIG.ollamaBaseUrl}: ${err.message}`);
  }

  return report;
}

/**
 * Standardize chapter names (e.g., 'mind' -> 'Mind', 'fever' -> 'Fever').
 */
export function normalizeChapterName(rawName) {
  if (!rawName) return null;
  const cleaned = rawName.trim().toLowerCase();
  const chapterMap = {
    mind: "Mind",
    vertigo: "Vertigo",
    head: "Head",
    eye: "Eye",
    vision: "Vision",
    ear: "Ear",
    hearing: "Hearing",
    nose: "Nose",
    face: "Face",
    mouth: "Mouth",
    teeth: "Teeth",
    throat: "Throat",
    "external throat": "External Throat",
    stomach: "Stomach",
    abdomen: "Abdomen",
    rectum: "Rectum",
    stool: "Stool",
    bladder: "Bladder",
    kidneys: "Kidneys",
    "prostate gland": "Prostate Gland",
    urethra: "Urethra",
    urine: "Urine",
    "genitalia male": "Genitalia Male",
    "genitalia female": "Genitalia Female",
    "larynx and trachea": "Larynx and Trachea",
    respiration: "Respiration",
    cough: "Cough",
    expectoration: "Expectoration",
    chest: "Chest",
    back: "Back",
    extremities: "Extremities",
    sleep: "Sleep",
    chill: "Chill",
    fever: "Fever",
    perspiration: "Perspiration",
    skin: "Skin",
    generalities: "Generalities",
  };
  return chapterMap[cleaned] || rawName;
}

/**
 * Stream rubrics from JSONL file into Document objects without text splitters.
 */
export async function loadRubricsFromJSONL(chapterFilter = null) {
  if (!fs.existsSync(CONFIG.jsonlPath)) {
    throw new Error(`JSONL dataset not found at ${CONFIG.jsonlPath}`);
  }

  const targetChapter = chapterFilter ? normalizeChapterName(chapterFilter) : null;
  const fileStream = fs.createReadStream(CONFIG.jsonlPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const documents = [];
  const rubricIndex = new Map(); // id -> rubric
  const childrenMap = new Map(); // parent rubric_path -> array of child rubrics

  for await (const line of rl) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);

    if (targetChapter && item.chapter.toLowerCase() !== targetChapter.toLowerCase()) {
      continue;
    }

    rubricIndex.set(item.id, item);

    // Track hierarchy for child lookup
    // If rubric_path has ' > ', find its direct parent
    const lastArrow = item.rubric_path.lastIndexOf(" > ");
    if (lastArrow !== -1) {
      const parentPath = item.rubric_path.slice(0, lastArrow);
      if (!childrenMap.has(parentPath)) {
        childrenMap.set(parentPath, []);
      }
      childrenMap.get(parentPath).push(item);
    }

    // STRICT RULE: No text splitters. Map directly to Document.
    // Remedies array is stored in metadata, NEVER in pageContent.
    const doc = new Document({
      pageContent: item.embedding_text || `Kent Repertory | Chapter: ${item.chapter} | Symptom Rubric: ${item.rubric_path}`,
      metadata: {
        id: item.id,
        book: item.book || "Kent's Repertory",
        author: item.author || "J.T. Kent",
        chapter: item.chapter,
        page: item.page,
        source_url: item.source_url,
        depth: item.depth,
        rubric_label: item.rubric_label,
        rubric_path: item.rubric_path,
        cross_references: item.cross_references || [],
        remedy_count: item.remedy_count || 0,
        remedies: item.remedies || [],
      },
    });

    documents.push(doc);
  }

  return { documents, rubricIndex, childrenMap };
}

/**
 * Compute cosine similarity between two Float32/Float64 vectors.
 */
export function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Persistent Vector Store using OllamaEmbeddings and local disk cache.
 */
export class PersistentKentVectorStore {
  constructor(chapterName = "all") {
    this.chapterName = chapterName;
    this.safeKey = (chapterName || "all").toLowerCase().replace(/[^a-z0-9]/g, "_");
    this.cacheFile = path.join(CONFIG.vectorCacheDir, `kent_${this.safeKey}_vectors.json`);
    this.embeddings = new OllamaEmbeddings({
      model: CONFIG.embeddingModel,
      baseUrl: CONFIG.ollamaBaseUrl,
    });
    this.documents = [];
    this.vectors = [];
    this.isLoaded = false;
  }

  async loadOrBuild(documents, onProgress = null) {
    if (!fs.existsSync(CONFIG.vectorCacheDir)) {
      fs.mkdirSync(CONFIG.vectorCacheDir, { recursive: true });
    }

    // Check if cached on disk
    if (fs.existsSync(this.cacheFile)) {
      if (onProgress) onProgress(`Loading cached vectors from ${this.cacheFile}...`);
      const raw = fs.readFileSync(this.cacheFile, "utf-8");
      const data = JSON.parse(raw);
      this.documents = data.documents.map((d) => new Document(d));
      this.vectors = data.vectors;
      this.isLoaded = true;
      if (onProgress) onProgress(`Loaded ${this.documents.length} vectors instantly from cache.`);
      return;
    }

    // Build vector store
    if (onProgress) onProgress(`Building persistent vector store for ${this.chapterName} (${documents.length} rubrics)...`);
    this.documents = documents;
    this.vectors = [];

    const total = documents.length;
    const batchSize = CONFIG.batchSize;

    for (let i = 0; i < total; i += batchSize) {
      const batchDocs = documents.slice(i, i + batchSize);
      const batchTexts = batchDocs.map((d) => d.pageContent);
      const batchEmbeddings = await this.embeddings.embedDocuments(batchTexts);
      this.vectors.push(...batchEmbeddings);

      if (onProgress) {
        const done = Math.min(i + batchSize, total);
        const pct = ((done / total) * 100).toFixed(1);
        onProgress(`Embedded ${done}/${total} rubrics (${pct}%)...`);
      }
    }

    // Persist to disk
    if (onProgress) onProgress(`Saving vectors to cache file: ${this.cacheFile}`);
    fs.writeFileSync(
      this.cacheFile,
      JSON.stringify({
        chapter: this.chapterName,
        count: this.documents.length,
        created_at: new Date().toISOString(),
        documents: this.documents.map((d) => ({
          pageContent: d.pageContent,
          metadata: d.metadata,
        })),
        vectors: this.vectors,
      })
    );

    this.isLoaded = true;
  }

  async similaritySearch(query, k = 5) {
    if (!this.isLoaded || this.vectors.length === 0) {
      throw new Error("Vector store not initialized.");
    }

    const queryVec = await this.embeddings.embedQuery(query);
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

    const scored = [];
    for (let i = 0; i < this.vectors.length; i++) {
      const vec = this.vectors[i];
      let sim = cosineSimilarity(queryVec, vec);

      // Lexical / Kentian Term bonus to boost exact keyword rubrics
      const pathLower = (this.documents[i].metadata.rubric_path || "").toLowerCase();
      let matchCount = 0;
      for (const term of queryTerms) {
        if (pathLower.includes(term)) {
          matchCount++;
        }
      }
      if (queryTerms.length > 0 && matchCount > 0) {
        sim += (matchCount / queryTerms.length) * 0.15; // Hybrid boost
      }

      scored.push({
        document: this.documents[i],
        score: sim,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}

/**
 * Retrieve immediate child sub-rubrics (depth: d + 1) for a parent rubric.
 */
export function getChildSubRubrics(parentRubric, childrenMap) {
  const parentPath = parentRubric.rubric_path;
  const parentDepth = parentRubric.depth;
  const rawChildren = childrenMap.get(parentPath) || [];

  // Filter children that are strictly at depth + 1
  return rawChildren.filter((child) => child.depth === parentDepth + 1);
}

/**
 * Ask the clinician 2-3 clarifying questions based on Kent's child sub-rubrics using ChatOllama.
 */
export async function askClarifyingQuestions(parentRubric, childRubrics) {
  if (!childRubrics || childRubrics.length === 0) {
    return "No child sub-rubrics found for further differentiation (this is a specific leaf rubric).";
  }

  const childLabels = childRubrics.map((c) => `"${c.rubric_label}" (${c.remedy_count} remedies)`).join(", ");

  const chat = new ChatOllama({
    model: CONFIG.chatModel,
    baseUrl: CONFIG.ollamaBaseUrl,
    temperature: 0.2,
  });

  const prompt = `You are an expert clinical homeopathic physician specializing in J.T. Kent's Repertory.
The doctor matched the following parent rubric:
- Chapter: ${parentRubric.chapter}
- Rubric: ${parentRubric.rubric_path} (Page: ${parentRubric.page})

Kent's Repertory provides the following immediate child sub-rubric differentiations:
${childLabels}

Formulate 2 to 3 concise, highly relevant clinical clarifying questions to ask the patient or physician to determine which sub-rubric is indicated (focusing on modalities like time of day, open air / warmth, motion, waking, or specific mental sensation). Keep it professional, brief, and directly tied to the sub-rubrics.`;

  try {
    const res = await chat.invoke(prompt);
    return res.content;
  } catch (err) {
    return `Clarifying questions (Fallback): The parent rubric has ${childRubrics.length} child modalities: ${childLabels}. Does the symptom exhibit specific time modalities (e.g., morning vs. evening) or environmental circumstances?`;
  }
}

/**
 * Calculate deterministic remedy repertorization matrix.
 * Sums remedy grades (3, 2, 1) and counts rubrics covered across selected rubrics.
 * Never guesses or approximates math.
 */
export function calculateDeterministicRepertorization(rubrics) {
  const remedyMap = new Map();

  for (let rIdx = 0; rIdx < rubrics.length; rIdx++) {
    const rubric = rubrics[rIdx];
    const remedies = rubric.remedies || (rubric.metadata && rubric.metadata.remedies) || [];

    for (const rem of remedies) {
      const abbr = rem.abbr;
      if (!remedyMap.has(abbr)) {
        remedyMap.set(abbr, {
          abbr: rem.abbr,
          full_name: rem.full_name || rem.abbr,
          rubrics_covered: 0,
          total_score: 0,
          rubric_grades: {},
        });
      }

      const entry = remedyMap.get(abbr);
      entry.rubrics_covered += 1;
      entry.total_score += rem.grade;
      entry.rubric_grades[rIdx] = rem.grade;
    }
  }

  // Sort: 1st by rubrics_covered (desc), 2nd by total_score (desc), 3rd by full_name (asc)
  const ranked = Array.from(remedyMap.values()).sort((a, b) => {
    if (b.rubrics_covered !== a.rubrics_covered) {
      return b.rubrics_covered - a.rubrics_covered;
    }
    if (b.total_score !== a.total_score) {
      return b.total_score - a.total_score;
    }
    return a.full_name.localeCompare(b.full_name);
  });

  return {
    rubricsCount: rubrics.length,
    rubricsList: rubrics.map((r, i) => ({
      index: i,
      path: r.rubric_path || (r.metadata && r.metadata.rubric_path),
      page: r.page || (r.metadata && r.metadata.page),
      remedy_count: (r.remedies || (r.metadata && r.metadata.remedies) || []).length,
    })),
    rankedRemedies: ranked,
  };
}

/**
 * Format the repertorization results as an ASCII/Markdown table.
 */
export function formatRepertorizationTable(matrix, limit = 15) {
  const { rubricsList, rankedRemedies } = matrix;
  if (rankedRemedies.length === 0) {
    return "No remedies found in the selected rubrics.";
  }

  let out = `### Deterministic Repertorization Matrix\n\n`;
  out += `**Analyzed Rubrics (${rubricsList.length}):**\n`;
  rubricsList.forEach((r, idx) => {
    out += `  [R${idx + 1}] Page ${r.page}: ${r.path} (${r.remedy_count} remedies)\n`;
  });
  out += `\n`;

  const headerCols = ["Rank", "Remedy Name", "Abbr", "Covered", "Score"];
  for (let i = 0; i < rubricsList.length; i++) {
    headerCols.push(`R${i + 1}`);
  }

  out += `| ` + headerCols.join(" | ") + ` |\n`;
  out += `| ` + headerCols.map(() => "---").join(" | ") + ` |\n`;

  const top = rankedRemedies.slice(0, limit);
  top.forEach((rem, idx) => {
    const row = [
      (idx + 1).toString(),
      rem.full_name,
      rem.abbr,
      `${rem.rubrics_covered}/${rubricsList.length}`,
      `**${rem.total_score}**`,
    ];
    for (let i = 0; i < rubricsList.length; i++) {
      const g = rem.rubric_grades[i];
      if (g === 3) row.push("**3**");
      else if (g === 2) row.push("*2*");
      else if (g === 1) row.push("1");
      else row.push("-");
    }
    out += `| ` + row.join(" | ") + ` |\n`;
  });

  return out;
}

/**
 * Main query workflow coordinator.
 */
export async function executeKentRAG({
  query,
  chapter = "Mind",
  topK = 5,
  includeQuestions = true,
  includeRepertorization = true,
  onLog = console.log,
}) {
  const normChapter = normalizeChapterName(chapter);
  onLog(`\n=== J.T. Kent Repertory Clinical Assistant ===`);
  onLog(`Query: "${query}" | Chapter: "${normChapter}" | TopK: ${topK}\n`);

  // 1. Load rubrics from JSONL
  onLog(`[1/4] Loading rubrics from ${CONFIG.jsonlPath}...`);
  const { documents, rubricIndex, childrenMap } = await loadRubricsFromJSONL(normChapter);
  onLog(`Loaded ${documents.length} rubrics for chapter '${normChapter}'.`);

  // 2. Load or Build Vector Store
  onLog(`[2/4] Initializing persistent vector store...`);
  const store = new PersistentKentVectorStore(normChapter);
  await store.loadOrBuild(documents, onLog);

  // 3. Perform Similarity Search
  onLog(`\n[3/4] Searching for top matches...`);
  const results = await store.similaritySearch(query, topK);

  const matchedRubrics = [];
  onLog(`\n--- Matched Rubrics ---`);
  for (let i = 0; i < results.length; i++) {
    const { document, score } = results[i];
    const m = document.metadata;
    matchedRubrics.push(m);

    onLog(`\n[Match ${i + 1}] (Score: ${score.toFixed(4)})`);
    onLog(`  Rubric:      ${m.rubric_path}`);
    onLog(`  Chapter:     ${m.chapter}`);
    onLog(`  Page:        ${m.page} | Author: ${m.author}`);
    onLog(`  Source URL:  ${m.source_url}`);
    onLog(`  Depth:       ${m.depth}`);
    onLog(`  Remedies:    ${m.remedy_count} remedies`);

    if (m.remedies && m.remedies.length > 0) {
      const topRemedies = m.remedies
        .slice(0, 10)
        .map((r) => `${r.abbr} (Grade ${r.grade}: ${r.full_name})`)
        .join(", ");
      onLog(`  Key Remedies: ${topRemedies}${m.remedies.length > 10 ? "..." : ""}`);
    }

    if (m.cross_references && m.cross_references.length > 0) {
      onLog(`  Cross Refs:  ${m.cross_references.join(", ")}`);
    }

    // Inspect child sub-rubrics
    const children = getChildSubRubrics(m, childrenMap);
    if (children.length > 0) {
      onLog(`  Immediate Sub-rubrics (depth ${m.depth + 1}): [${children.map((c) => c.rubric_label).join(", ")}]`);
    } else {
      onLog(`  Immediate Sub-rubrics: None (Leaf rubric).`);
    }
  }

  // Generate clarifying questions from the most relevant rubric with children
  if (includeQuestions && matchedRubrics.length > 0) {
    let targetRubricForQuestions = null;
    let targetChildren = [];

    // Option A: Top match has children
    const topMatch = matchedRubrics[0];
    const topChildren = getChildSubRubrics(topMatch, childrenMap);
    if (topChildren.length > 0) {
      targetRubricForQuestions = topMatch;
      targetChildren = topChildren;
    } else {
      // Option B: Top match is a leaf - check its parent rubric
      const lastArrow = topMatch.rubric_path.lastIndexOf(" > ");
      if (lastArrow !== -1) {
        const parentPath = topMatch.rubric_path.slice(0, lastArrow);
        const parentRubric = Array.from(rubricIndex.values()).find((r) => r.rubric_path === parentPath);
        if (parentRubric) {
          const parentChildren = getChildSubRubrics(parentRubric, childrenMap);
          if (parentChildren.length > 0) {
            targetRubricForQuestions = parentRubric;
            targetChildren = parentChildren;
          }
        }
      }
      // Option C: Any other matched rubric with children
      if (!targetRubricForQuestions) {
        for (const m of matchedRubrics) {
          const ch = getChildSubRubrics(m, childrenMap);
          if (ch.length > 0) {
            targetRubricForQuestions = m;
            targetChildren = ch;
            break;
          }
        }
      }
    }

    if (targetRubricForQuestions && targetChildren.length > 0) {
      onLog(`\n  --- Generating Clarifying Questions with ChatOllama (${CONFIG.chatModel}) ---`);
      onLog(`  (Context: ${targetRubricForQuestions.rubric_path} [Page ${targetRubricForQuestions.page}])`);
      const questions = await askClarifyingQuestions(targetRubricForQuestions, targetChildren);
      onLog(`\n${questions}\n`);
    }
  }

  // 4. Deterministic Repertorization
  let matrix = null;
  if (includeRepertorization && matchedRubrics.length > 0) {
    onLog(`\n[4/4] Calculating Deterministic Repertorization Matrix...`);
    matrix = calculateDeterministicRepertorization(matchedRubrics);
    const table = formatRepertorizationTable(matrix, 15);
    onLog(`\n` + table);
  }

  return {
    results,
    matchedRubrics,
    matrix,
  };
}

// CLI handler if invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes("--check")) {
    console.log("Checking Kent RAG Environment...");
    checkEnvironment().then((rep) => {
      console.log("\nPre-flight Check Results:");
      console.log(`- Dataset present:         ${rep.dataset ? "✅ YES" : "❌ NO"}`);
      console.log(`- Ollama service running:  ${rep.ollama ? "✅ YES" : "❌ NO"}`);
      console.log(`- Embedding model:         ${rep.embeddingModel ? "✅ YES (nomic-embed-text)" : "❌ NO"}`);
      console.log(`- Chat model:              ${rep.chatModel ? "✅ YES (llama3.2)" : "❌ NO"}`);
      console.log(`- Available models:        ${rep.modelsAvailable.join(", ") || "None"}`);
      if (rep.errors.length > 0) {
        console.log(`\nErrors/Warnings:`);
        rep.errors.forEach((e) => console.log(`  - ${e}`));
        process.exit(1);
      } else {
        console.log("\nEnvironment is fully healthy and ready!");
      }
    });
  } else {
    let query = "forsaken feeling in the evening";
    let chapter = "Mind";
    let topK = 5;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--query" && args[i + 1]) query = args[++i];
      if (args[i] === "--chapter" && args[i + 1]) chapter = args[++i];
      if (args[i] === "--topK" && args[i + 1]) topK = parseInt(args[++i], 10);
    }

    executeKentRAG({ query, chapter, topK }).catch((err) => {
      console.error("Execution error:", err);
      process.exit(1);
    });
  }
}
