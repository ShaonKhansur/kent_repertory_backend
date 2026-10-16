import { Request, Response } from "express";
import { DatasetService } from "../services/dataset.service.js";
import { LocalEmbeddingService } from "../services/embed.service.js";
import { LanceDBService } from "../services/lancedb.service.js";
import { SupabaseService } from "../services/supabase.service.js";
import { SearchRequest, SearchResponse, SearchedRubricItem } from "../types/api.types.js";
import { RubricMetadata, Document } from "../types/rubric.types.js";
import { SearchResult } from "../types/vector.types.js";

/**
 * Instant lexical / keyword search across rubrics (< 5ms).
 * Runs instantly as fallback without requiring vector embedding generation.
 */
export function lexicalSearch(
  docs: Document<RubricMetadata>[],
  query: string,
  topK = 10
): SearchResult[] {
  const queryLower = query.toLowerCase().trim();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

  const scored: { document: Document<RubricMetadata>; score: number }[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const meta = doc.metadata;
    const pathLower = (meta.rubric_path || "").toLowerCase();
    const labelLower = (meta.rubric_label || "").toLowerCase();

    let score = 0;

    // Exact full phrase match in path (+0.6)
    if (pathLower.includes(queryLower)) {
      score += 0.6;
    }

    // Leaf rubric exact match (+0.3)
    if (labelLower === queryLower) {
      score += 0.3;
    } else if (labelLower.includes(queryLower)) {
      score += 0.15;
    }

    // Term hits overlap
    let termHits = 0;
    for (const term of queryTerms) {
      if (pathLower.includes(term)) {
        termHits++;
      }
    }

    if (queryTerms.length > 0 && termHits > 0) {
      score += (termHits / queryTerms.length) * 0.4;
    }

    if (score > 0) {
      scored.push({ document: doc, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export async function searchHandler(
  req: Request<Record<string, never>, unknown, SearchRequest>,
  res: Response
): Promise<void> {
  try {
    const { query, chapters, chapter, topK } = req.body;

    if (!query || typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "Missing or invalid 'query' parameter." });
      return;
    }

    const limit = Math.max(1, Math.min(100, typeof topK === "number" ? topK : parseInt(String(topK), 10) || 10));

    const dataset = DatasetService.getInstance();
    await dataset.ensureLoaded();

    const rawChapters = chapters !== undefined && chapters !== null ? chapters : chapter;
    const targetChapters = dataset.normalizeChapters(rawChapters);

    if (targetChapters.length === 0) {
      res.status(400).json({
        error: "No valid chapters specified.",
        available_chapters: dataset.getAvailableChapters(),
      });
      return;
    }

    const supabaseService = SupabaseService.getInstance();
    const isSupabaseReady = await supabaseService.isReady();

    const lanceService = LanceDBService.getInstance();
    let rubrics: SearchedRubricItem[] = [];

    // 1. Vector Search via Supabase pgvector
    if (isSupabaseReady) {
      try {
        const embedService = LocalEmbeddingService.getInstance();
        const queryVec = await embedService.embedQuery(query.trim());
        rubrics = await supabaseService.search({
          query: query.trim(),
          queryVector: queryVec,
          chapters: targetChapters,
          topK: limit,
        });
      } catch (err) {
        console.warn("Supabase vector search error, falling back to local database:", err);
      }
    }

    // 2. Vector Search via local LanceDB (if Supabase not ready or returned 0)
    if (rubrics.length === 0 && (await lanceService.isReady())) {
      try {
        const embedService = LocalEmbeddingService.getInstance();
        const queryVec = await embedService.embedQuery(query.trim());
        rubrics = await lanceService.search({
          query: query.trim(),
          queryVector: queryVec,
          chapters: targetChapters,
          topK: limit,
        });
      } catch (err) {
        console.warn("LanceDB vector search failed, falling back to lexical search:", err);
      }
    }

    // 2. Resilient Lexical Fallback if LanceDB had 0 matches or is not yet ingested
    if (rubrics.length === 0) {
      const lexicalMatches: SearchResult[] = [];
      for (const normChapter of targetChapters) {
        const docs = dataset.getDocumentsForChapter(normChapter);
        const chapterMatches = lexicalSearch(docs, query, limit);
        lexicalMatches.push(...chapterMatches);
      }

      lexicalMatches.sort((a, b) => b.score - a.score);
      const topLexical = lexicalMatches.slice(0, limit);

      rubrics = topLexical.map((m) => {
        const meta = m.document.metadata;
        const children = dataset.getImmediateChildren(meta.rubric_path, meta.depth);

        return {
          id: meta.id,
          rubric_path: meta.rubric_path,
          rubric_label: meta.rubric_label,
          chapter: meta.chapter,
          page: meta.page,
          author: meta.author,
          source_url: meta.source_url,
          depth: meta.depth,
          similarity_score: parseFloat(m.score.toFixed(4)),
          remedy_count: meta.remedy_count,
          remedies: meta.remedies,
          immediate_child_rubrics: children.map((c) => c.rubric_label),
        };
      });
    }

    const response: SearchResponse = {
      query: query.trim(),
      chapter: targetChapters.length === 1 ? targetChapters[0] : targetChapters.join(", "),
      chapters: targetChapters,
      count: rubrics.length,
      rubrics,
    };

    res.json(response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to execute search.", details: msg });
  }
}
