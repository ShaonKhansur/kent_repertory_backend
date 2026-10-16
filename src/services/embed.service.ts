import { pipeline } from "@xenova/transformers";

export class LocalEmbeddingService {
  private static instance: LocalEmbeddingService;
  private extractor: any = null;
  private initPromise: Promise<void> | null = null;
  public readonly modelName = "Xenova/nomic-embed-text-v1";
  public readonly dimensions = 768;

  public static getInstance(): LocalEmbeddingService {
    if (!LocalEmbeddingService.instance) {
      LocalEmbeddingService.instance = new LocalEmbeddingService();
    }
    return LocalEmbeddingService.instance;
  }

  public async init(): Promise<void> {
    if (this.extractor) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Load in-process ONNX model (quantized for low memory < 400MB and fast boot)
        this.extractor = await pipeline("feature-extraction", this.modelName, { quantized: true });
      } catch (err) {
        console.error("Failed to initialize in-process embedding pipeline:", err);
        this.initPromise = null;
        throw err;
      }
    })();

    return this.initPromise;
  }

  public async isReady(): Promise<boolean> {
    try {
      await this.init();
      return this.extractor !== null;
    } catch {
      return false;
    }
  }

  /**
   * Generates a 768-dimensional normalized embedding vector in pure Node.js in ~15ms.
   * Zero external HTTP calls, zero Ollama daemon required.
   */
  public async embedQuery(text: string): Promise<number[]> {
    await this.init();
    if (!this.extractor) {
      throw new Error("Local embedding extractor is not initialized.");
    }

    const cleanText = text.trim();
    const output = await this.extractor(cleanText, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data);
  }

  /**
   * Embeds a batch of texts for document ingestion.
   */
  public async embedDocuments(texts: string[]): Promise<number[][]> {
    await this.init();
    if (!this.extractor) {
      throw new Error("Local embedding extractor is not initialized.");
    }

    const results: number[][] = [];
    for (const text of texts) {
      const vec = await this.embedQuery(text);
      results.push(vec);
    }
    return results;
  }
}
