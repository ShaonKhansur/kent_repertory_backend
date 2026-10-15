import fs from "fs";
import path from "path";
import { CONFIG } from "../config/env.config.js";
import { RubricMetadata, Document } from "../types/rubric.types.js";
import { IKentVectorStore, SearchResult } from "../types/vector.types.js";
import { LocalEmbeddingService } from "./embed.service.js";

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
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

export class PersistentKentVectorStore implements IKentVectorStore {
  public chapterName: string;
  public isLoaded = false;
  private safeKey: string;
  private cacheFile: string;
  private embedService: LocalEmbeddingService;
  private documents: Document<RubricMetadata>[] = [];
  private vectors: number[][] = [];

  constructor(chapterName = "all") {
    this.chapterName = chapterName;
    this.safeKey = chapterName.toLowerCase().replace(/[^a-z0-9]/g, "_");
    this.cacheFile = path.join(CONFIG.vectorCacheDir, `kent_${this.safeKey}_vectors.json`);
    this.embedService = LocalEmbeddingService.getInstance();
  }

  public hasDiskCache(): boolean {
    return fs.existsSync(this.cacheFile);
  }

  public async loadOrBuild(
    documents: Document<RubricMetadata>[],
    onProgress?: (msg: string) => void
  ): Promise<void> {
    if (this.isLoaded) return;

    if (!fs.existsSync(CONFIG.vectorCacheDir)) {
      fs.mkdirSync(CONFIG.vectorCacheDir, { recursive: true });
    }

    // 1. Try to load from disk cache
    if (fs.existsSync(this.cacheFile)) {
      if (onProgress) onProgress(`Loading vectors from cache: ${this.cacheFile}...`);
      const raw = fs.readFileSync(this.cacheFile, "utf-8");
      const data = JSON.parse(raw);
      this.documents = data.documents.map(
        (d: { pageContent: string; metadata: RubricMetadata }) =>
          new Document<RubricMetadata>({
            pageContent: d.pageContent,
            metadata: d.metadata,
          })
      );
      this.vectors = data.vectors;
      this.isLoaded = true;
      if (onProgress) onProgress(`Loaded ${this.documents.length} vectors instantly from cache.`);
      return;
    }

    // 2. Generate embeddings via Ollama
    if (onProgress) onProgress(`Building vector store for ${this.chapterName} (${documents.length} rubrics)...`);
    this.documents = documents;
    this.vectors = [];

    const total = documents.length;
    const batchSize = CONFIG.batchSize;

    for (let i = 0; i < total; i += batchSize) {
      const batchDocs = documents.slice(i, i + batchSize);
      const batchTexts = batchDocs.map((d) => d.pageContent);
      const batchEmbeddings = await this.embedService.embedDocuments(batchTexts);
      this.vectors.push(...batchEmbeddings);

      if (onProgress) {
        const done = Math.min(i + batchSize, total);
        const pct = ((done / total) * 100).toFixed(1);
        onProgress(`Embedded ${done}/${total} rubrics (${pct}%)...`);
      }
    }

    // 3. Persist to cache file
    if (onProgress) onProgress(`Saving vectors to ${this.cacheFile}...`);
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

  public similaritySearchWithVector(query: string, queryVec: number[], k = 5): SearchResult[] {
    if (!this.isLoaded || this.vectors.length === 0) {
      throw new Error(`Vector store for chapter '${this.chapterName}' is not loaded.`);
    }

    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

    const scored: SearchResult[] = [];
    for (let i = 0; i < this.vectors.length; i++) {
      let sim = cosineSimilarity(queryVec, this.vectors[i]);

      // Exact Kentian term boost
      const pathLower = (this.documents[i].metadata.rubric_path || "").toLowerCase();
      let matchCount = 0;
      for (const term of queryTerms) {
        if (pathLower.includes(term)) {
          matchCount++;
        }
      }
      if (queryTerms.length > 0 && matchCount > 0) {
        sim += (matchCount / queryTerms.length) * 0.15;
      }

      scored.push({
        document: this.documents[i],
        score: sim,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  public async similaritySearch(query: string, k = 5): Promise<SearchResult[]> {
    const queryVec = await this.embedService.embedQuery(query);
    return this.similaritySearchWithVector(query, queryVec, k);
  }
}

export class VectorStoreManager {
  private static stores: Map<string, PersistentKentVectorStore> = new Map();

  public static async embedQuery(query: string): Promise<number[]> {
    return LocalEmbeddingService.getInstance().embedQuery(query);
  }

  public static getStore(chapterName: string): PersistentKentVectorStore {
    const key = (chapterName || "all").toLowerCase();
    if (!this.stores.has(key)) {
      this.stores.set(key, new PersistentKentVectorStore(chapterName));
    }
    return this.stores.get(key)!;
  }

  public static listCachedChapters(): string[] {
    if (!fs.existsSync(CONFIG.vectorCacheDir)) return [];
    const files = fs.readdirSync(CONFIG.vectorCacheDir);
    return files
      .filter((f) => f.startsWith("kent_") && f.endsWith("_vectors.json"))
      .map((f) => f.replace("kent_", "").replace("_vectors.json", ""));
  }
}
