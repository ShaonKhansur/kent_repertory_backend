import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../");

export const CONFIG = {
  port: parseInt(process.env.PORT || "3000", 10),
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_KEY || "",
  jsonlPath: process.env.JSONL_PATH || path.resolve(rootDir, "kent_output", "kent_repertory_full.jsonl"),
  vectorCacheDir: process.env.VECTOR_CACHE_DIR || path.resolve(rootDir, "kent_vector_cache"),
  lanceDbDir: process.env.LANCEDB_DIR || path.resolve(rootDir, "kent_lancedb"),
  lanceTableName: "kent_rubrics",
  embeddingModel: process.env.EMBEDDING_MODEL || "Xenova/nomic-embed-text-v1",
  batchSize: 64,
};
