import { SupabaseService } from "../services/supabase.service.js";
import { LocalEmbeddingService } from "../services/embed.service.js";

async function main() {
  console.log("=== Testing Supabase Connection & Vector Search ===");
  const service = SupabaseService.getInstance();
  const client = service.getClient();

  // 1. Check count
  const count = await service.getRecordCount();
  console.log(`- Current rubrics row count: ${count.toLocaleString()}`);

  // 2. Inspect a row
  const { data: sample, error: err1 } = await client
    .from("rubrics")
    .select("id, chapter, rubric_path, page, embedding")
    .limit(1);

  if (err1) {
    console.error("Error reading sample:", err1);
    return;
  }
  console.log("- Sample row:", {
    id: sample?.[0]?.id,
    chapter: sample?.[0]?.chapter,
    rubric_path: sample?.[0]?.rubric_path,
    page: sample?.[0]?.page,
    embedding_type: typeof sample?.[0]?.embedding,
  });

  // 3. Test RPC
  const embed = LocalEmbeddingService.getInstance();
  const query = "anxiety in the evening";
  const vec = await embed.embedQuery(query);

  console.log(`\n- Testing RPC match_rubrics for: "${query}"...`);

  // Try with chapters filter
  const { data: rpcData, error: rpcErr } = await client.rpc("match_rubrics", {
    query_embedding: vec,
    match_count: 5,
    filter_chapters: null,
  });

  if (rpcErr) {
    console.error("RPC Error:", rpcErr);
  } else {
    console.log(`- RPC returned ${rpcData?.length || 0} results!`);
    for (const r of (rpcData || [])) {
      console.log(`  • [${r.similarity.toFixed(4)}] ${r.rubric_path} (Page ${r.page})`);
    }
  }

  // Try with chapter = ["Mind"]
  const { data: rpcMind, error: rpcMindErr } = await client.rpc("match_rubrics", {
    query_embedding: vec,
    match_count: 5,
    filter_chapters: ["Mind"],
  });

  if (rpcMindErr) {
    console.error("RPC Mind Error:", rpcMindErr);
  } else {
    console.log(`\n- RPC (Mind chapter only) returned ${rpcMind?.length || 0} results:`);
    for (const r of (rpcMind || [])) {
      console.log(`  • [${r.similarity.toFixed(4)}] ${r.rubric_path} (Page ${r.page})`);
    }
  }
}

main().catch(console.error);
