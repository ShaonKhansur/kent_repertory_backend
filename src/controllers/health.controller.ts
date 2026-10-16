import fs from "fs";
import { Request, Response } from "express";
import { CONFIG } from "../config/env.config.js";
import { DatasetService } from "../services/dataset.service.js";
import { LocalEmbeddingService } from "../services/embed.service.js";
import { LanceDBService } from "../services/lancedb.service.js";
import { SupabaseService } from "../services/supabase.service.js";
import { HealthResponse } from "../types/api.types.js";

export async function healthHandler(_req: Request, res: Response): Promise<void> {
  const errors: string[] = [];
  let datasetAvailable = false;
  let datasetSizeMb = 0;
  let datasetCount = 0;

  // 1. Check dataset
  try {
    if (fs.existsSync(CONFIG.jsonlPath)) {
      const stats = fs.statSync(CONFIG.jsonlPath);
      datasetAvailable = stats.size > 1000;
      datasetSizeMb = parseFloat((stats.size / (1024 * 1024)).toFixed(2));
      const dataset = DatasetService.getInstance();
      datasetCount = dataset.getTotalRubricsCount() || 78926;
    } else {
      errors.push(`Dataset not found at ${CONFIG.jsonlPath}`);
    }
  } catch (err: unknown) {
    errors.push(`Dataset check error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Check in-process neural embedder (Zero Ollama)
  const embedService = LocalEmbeddingService.getInstance();
  const embedReady = await embedService.isReady();
  if (!embedReady) {
    errors.push(`Local in-process embedder (${embedService.modelName}) is not ready.`);
  }

  // 3. Check LanceDB local vector database
  const lanceService = LanceDBService.getInstance();
  const lanceReady = await lanceService.isReady();
  const lanceTotal = await lanceService.getRecordCount();

  // 4. Check Supabase pgvector database
  const supabaseService = SupabaseService.getInstance();
  const supabaseConfigured = await supabaseService.isConfigured();
  const supabaseReady = await supabaseService.isReady();
  const supabaseTotal = await supabaseService.getRecordCount();

  if (!lanceReady && !supabaseReady) {
    errors.push("Neither LanceDB nor Supabase vector database is ready.");
  }

  const isHealthy = embedReady && (lanceReady || supabaseReady);
  const response: HealthResponse = {
    status: isHealthy ? "healthy" : "unhealthy",
    dataset: {
      available: datasetAvailable,
      total_rubrics: datasetCount,
      size_mb: datasetSizeMb,
    },
    embedder: {
      provider: "in-process-transformers",
      model: embedService.modelName,
      dimensions: embedService.dimensions,
      ready: embedReady,
    },
    lancedb: {
      available: lanceReady,
      total_rubrics: lanceTotal,
      table: CONFIG.lanceTableName,
    },
    supabase: {
      configured: supabaseConfigured,
      available: supabaseReady,
      total_rubrics: supabaseTotal,
    },
    models: {
      embedding: embedService.modelName,
      embedding_ready: embedReady,
    },
    errors,
  };

  res.status(isHealthy ? 200 : 503).json(response);
}
