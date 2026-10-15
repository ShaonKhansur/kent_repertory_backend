import { Document, RubricMetadata } from "./rubric.types.js";

export interface SearchResult {
  document: Document<RubricMetadata>;
  score: number;
}

export interface IKentVectorStore {
  chapterName: string;
  isLoaded: boolean;
  loadOrBuild(documents: Document<RubricMetadata>[], onProgress?: (msg: string) => void): Promise<void>;
  similaritySearch(query: string, k?: number): Promise<SearchResult[]>;
}
