import fs from "fs";
import * as lancedb from "@lancedb/lancedb";
import { CONFIG } from "../config/env.config.js";
import { SearchedRubricItem } from "../types/api.types.js";
import { Remedy } from "../types/rubric.types.js";

export interface LanceRubricRow extends Record<string, unknown> {
  id: string;
  rubric_path: string;
  rubric_label: string;
  chapter: string;
  page: number;
  author: string;
  source_url: string;
  depth: number;
  remedy_count: number;
  remedies_json: string;
  immediate_children_json: string;
  embedding_text?: string;
  vector: number[];
  _distance?: number;
}

export class LanceDBService {
  private static instance: LanceDBService;
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;

  public static getInstance(): LanceDBService {
    if (!LanceDBService.instance) {
      LanceDBService.instance = new LanceDBService();
    }
    return LanceDBService.instance;
  }

  public async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        if (!fs.existsSync(CONFIG.lanceDbDir)) {
          fs.mkdirSync(CONFIG.lanceDbDir, { recursive: true });
        }
        this.db = await lancedb.connect(CONFIG.lanceDbDir);
        const tables = await this.db.tableNames();
        if (tables.includes(CONFIG.lanceTableName)) {
          this.table = await this.db.openTable(CONFIG.lanceTableName);
        }
      } catch (err) {
        console.warn("LanceDB init warning (table may not be created yet):", err);
      }
    })();
    return this.initPromise;
  }

  public async isReady(): Promise<boolean> {
    await this.init();
    if (!this.table) {
      if (!this.db) return false;
      const tables = await this.db.tableNames();
      if (tables.includes(CONFIG.lanceTableName)) {
        this.table = await this.db.openTable(CONFIG.lanceTableName);
      }
    }
    if (!this.table) return false;
    try {
      const count = await this.table.countRows();
      return count > 0;
    } catch {
      return false;
    }
  }

  public async getRecordCount(): Promise<number> {
    if (!(await this.isReady())) return 0;
    return this.table!.countRows();
  }

  public async search(params: {
    query: string;
    queryVector: number[];
    chapters?: string[];
    topK: number;
  }): Promise<SearchedRubricItem[]> {
    if (!(await this.isReady())) {
      throw new Error("LanceDB table is not ready or has not been populated.");
    }

    const { query, queryVector, chapters, topK } = params;
    let queryBuilder = this.table!
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .limit(topK);

    // Apply chapter filter if specific chapters given and not all 37
    if (chapters && chapters.length > 0 && chapters.length < 37) {
      if (chapters.length === 1) {
        const safeCh = chapters[0].replace(/'/g, "\\'");
        queryBuilder = queryBuilder.where(`chapter = '${safeCh}'`);
      } else {
        const escaped = chapters.map((c) => `'${c.replace(/'/g, "\\'")}'`).join(", ");
        queryBuilder = queryBuilder.where(`chapter IN (${escaped})`);
      }
    }

    const rows = (await queryBuilder.toArray()) as LanceRubricRow[];
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

    return rows.map((r) => {
      // Base similarity: 1 - cosine distance
      let sim = Math.max(0, Math.min(1, 1 - (r._distance ?? 0)));

      // Exact Kentian term boost
      const pathLower = (r.rubric_path || "").toLowerCase();
      let matchCount = 0;
      for (const term of queryTerms) {
        if (pathLower.includes(term)) matchCount++;
      }
      if (queryTerms.length > 0 && matchCount > 0) {
        sim += (matchCount / queryTerms.length) * 0.15;
      }

      let remedies: Remedy[] = [];
      try {
        remedies = JSON.parse(r.remedies_json || "[]");
      } catch {
        remedies = [];
      }

      let immediate_child_rubrics: string[] = [];
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
        author: r.author,
        source_url: r.source_url,
        depth: r.depth,
        similarity_score: parseFloat(sim.toFixed(4)),
        remedy_count: r.remedy_count,
        remedies,
        immediate_child_rubrics,
      };
    });
  }
}
