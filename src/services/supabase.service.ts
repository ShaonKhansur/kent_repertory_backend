import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { CONFIG } from "../config/env.config.js";
import { SearchedRubricItem } from "../types/api.types.js";
import { Remedy, Rubric } from "../types/rubric.types.js";

export interface SupabaseRubricRow {
  id: string;
  rubric_path: string;
  rubric_label: string;
  chapter: string;
  page: number;
  author: string;
  source_url: string;
  depth: number;
  remedy_count: number;
  remedies: Remedy[];
  immediate_child_rubrics: string[];
  embedding?: number[];
  similarity?: number;
}

export class SupabaseService {
  private static instance: SupabaseService;
  private client: SupabaseClient | null = null;

  public static getInstance(): SupabaseService {
    if (!SupabaseService.instance) {
      SupabaseService.instance = new SupabaseService();
    }
    return SupabaseService.instance;
  }

  public getClient(): SupabaseClient {
    if (!this.client) {
      if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
        throw new Error("Missing SUPABASE_URL or SUPABASE_KEY in environment variables.");
      }
      this.client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
        auth: { persistSession: false },
      });
    }
    return this.client;
  }

  public async isConfigured(): Promise<boolean> {
    return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseKey);
  }

  public async isReady(): Promise<boolean> {
    if (!(await this.isConfigured())) return false;
    try {
      const client = this.getClient();
      const { count, error } = await client
        .from("rubrics")
        .select("*", { count: "exact", head: true });
      if (error) return false;
      return typeof count === "number" && count > 0;
    } catch {
      return false;
    }
  }

  public async getRecordCount(): Promise<number> {
    try {
      const client = this.getClient();
      const { count, error } = await client
        .from("rubrics")
        .select("*", { count: "exact", head: true });
      if (error || count === null) return 0;
      return count;
    } catch {
      return 0;
    }
  }

  public async search(params: {
    query: string;
    queryVector: number[];
    chapters?: string[];
    topK: number;
  }): Promise<SearchedRubricItem[]> {
    const client = this.getClient();
    const { query, queryVector, chapters, topK } = params;

    // Filter chapters if not searching all 37
    const filterChapters = chapters && chapters.length > 0 && chapters.length < 37 ? chapters : null;

    const { data, error } = await client.rpc("match_rubrics", {
      query_embedding: queryVector,
      match_count: topK,
      filter_chapters: filterChapters,
    });

    if (error) {
      throw new Error(`Supabase vector search error: ${error.message}`);
    }

    const rows = (data || []) as SupabaseRubricRow[];
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

    return rows.map((r) => {
      let sim = r.similarity ?? 0;

      // Exact Kentian term boost
      const pathLower = (r.rubric_path || "").toLowerCase();
      let matchCount = 0;
      for (const term of queryTerms) {
        if (pathLower.includes(term)) matchCount++;
      }
      if (queryTerms.length > 0 && matchCount > 0) {
        sim += (matchCount / queryTerms.length) * 0.15;
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
        remedies: Array.isArray(r.remedies) ? r.remedies : [],
        immediate_child_rubrics: Array.isArray(r.immediate_child_rubrics) ? r.immediate_child_rubrics : [],
      };
    });
  }

  public async getRubricsByIds(ids: string[]): Promise<Rubric[]> {
    const client = this.getClient();
    const { data, error } = await client
      .from("rubrics")
      .select("id, rubric_path, rubric_label, chapter, page, author, source_url, depth, remedy_count, remedies")
      .in("id", ids);

    if (error || !data) return [];
    return data.map((r) => ({
      ...r,
      book: "Kent's Repertory",
      cross_references: [],
      remedies: Array.isArray(r.remedies) ? r.remedies : [],
    }));
  }

  public async getRubricsByPaths(paths: string[]): Promise<Rubric[]> {
    const client = this.getClient();
    const { data, error } = await client
      .from("rubrics")
      .select("id, rubric_path, rubric_label, chapter, page, author, source_url, depth, remedy_count, remedies")
      .in("rubric_path", paths);

    if (error || !data) return [];
    return data.map((r) => ({
      ...r,
      book: "Kent's Repertory",
      cross_references: [],
      remedies: Array.isArray(r.remedies) ? r.remedies : [],
    }));
  }

  public async upsertBatch(rows: SupabaseRubricRow[]): Promise<void> {
    const client = this.getClient();
    const { error } = await client.from("rubrics").upsert(rows, { onConflict: "id" });
    if (error) {
      throw new Error(`Failed to upsert batch to Supabase: ${error.message}`);
    }
  }
}
