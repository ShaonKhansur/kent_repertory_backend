import { pipeline } from "@xenova/transformers";

async function main() {
  console.log("=== Pre-caching Quantized Embedding Model for Production ===");
  const start = Date.now();
  await pipeline("feature-extraction", "Xenova/nomic-embed-text-v1", { quantized: true });
  console.log(`✓ Model pre-cached successfully in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

main().catch((err) => {
  console.error("Warning: Failed to pre-cache model during build:", err);
  // Do not fail build if HuggingFace network is temporarily unreachable
  process.exit(0);
});
