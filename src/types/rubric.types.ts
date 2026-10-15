export interface Remedy {
  abbr: string;
  full_name: string;
  grade: 1 | 2 | 3;
}

export interface Rubric {
  id: string;
  book: string;
  author: string;
  chapter: string;
  page: number;
  source_url: string;
  depth: number;
  rubric_label: string;
  rubric_path: string;
  embedding_text?: string;
  cross_references: string[];
  remedy_count: number;
  remedies: Remedy[];
}

export interface RubricMetadata {
  id: string;
  book: string;
  author: string;
  chapter: string;
  page: number;
  source_url: string;
  depth: number;
  rubric_label: string;
  rubric_path: string;
  cross_references: string[];
  remedy_count: number;
  remedies: Remedy[];
  [key: string]: unknown;
}

export interface ChildRubricInfo {
  id: string;
  rubric_label: string;
  rubric_path: string;
  depth: number;
  remedy_count: number;
}

export class Document<T = Record<string, unknown>> {
  public pageContent: string;
  public metadata: T;

  constructor(fields: { pageContent: string; metadata: T }) {
    this.pageContent = fields.pageContent;
    this.metadata = fields.metadata;
  }
}

