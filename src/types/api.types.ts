import { Remedy } from "./rubric.types.js";

export interface SearchRequest {
  query: string;
  chapters?: string[] | string;
  chapter?: string;
  topK?: number;
}

export interface SearchedRubricItem {
  id: string;
  rubric_path: string;
  rubric_label: string;
  chapter: string;
  page: number;
  author: string;
  source_url: string;
  depth: number;
  similarity_score: number;
  remedy_count: number;
  remedies: Remedy[];
  immediate_child_rubrics: string[];
}

export interface SearchResponse {
  query: string;
  chapter: string;
  chapters: string[];
  count: number;
  rubrics: SearchedRubricItem[];
}

export interface ClarifyRequest {
  rubric_id?: string;
  rubric_path?: string;
  chapter?: string;
}

export interface ClarifyResponse {
  rubric_path: string;
  chapter: string;
  page: number;
  child_sub_rubrics: Array<{ label: string; remedies_count: number }>;
  clarifying_questions: string;
}

export interface RepertorizeRequest {
  rubric_ids?: string[];
  rubric_paths?: string[];
}

export interface RankedRemedyItem {
  rank: number;
  abbr: string;
  full_name: string;
  rubrics_covered: number;
  total_score: number;
  rubric_grades: Record<number, number>;
}

export interface RepertorizeResponse {
  rubrics_analyzed: number;
  rubrics_summary: Array<{ index: number; path: string; page: number; remedy_count: number }>;
  ranked_remedies: RankedRemedyItem[];
}

export interface HealthResponse {
  status: "healthy" | "unhealthy";
  dataset: {
    available: boolean;
    total_rubrics?: number;
    size_mb?: number;
  };
  embedder?: {
    provider: string;
    model: string;
    dimensions: number;
    ready: boolean;
  };
  lancedb?: {
    available: boolean;
    total_rubrics: number;
    table: string;
  };
  ollama?: {
    connected: boolean;
    url?: string;
    models_available?: string[];
  };
  models?: {
    embedding: string;
    embedding_ready: boolean;
  };
  cached_chapters?: string[];
  errors: string[];
}
