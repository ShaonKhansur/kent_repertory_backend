import fs from "fs";
import readline from "readline";
import { CONFIG } from "../config/env.config.js";
import { Rubric, RubricMetadata, ChildRubricInfo, Document } from "../types/rubric.types.js";

export class DatasetService {
  private static instance: DatasetService;
  private rubricById: Map<string, Rubric> = new Map();
  private rubricByPath: Map<string, Rubric> = new Map();
  private childrenMap: Map<string, Rubric[]> = new Map();
  private documentsByChapter: Map<string, Document<RubricMetadata>[]> = new Map();
  private allDocuments: Document<RubricMetadata>[] = [];
  private isLoaded = false;

  private chapterMap: Record<string, string> = {
    mind: "Mind",
    vertigo: "Vertigo",
    head: "Head",
    eye: "Eye",
    vision: "Vision",
    ear: "Ear",
    hearing: "Hearing",
    nose: "Nose",
    face: "Face",
    mouth: "Mouth",
    teeth: "Teeth",
    throat: "Throat",
    "external throat": "External Throat",
    stomach: "Stomach",
    abdomen: "Abdomen",
    rectum: "Rectum",
    stool: "Stool",
    bladder: "Bladder",
    kidneys: "Kidneys",
    "prostate gland": "Prostate Gland",
    urethra: "Urethra",
    urine: "Urine",
    "genitalia male": "Genitalia Male",
    "genitalia female": "Genitalia Female",
    "larynx and trachea": "Larynx and Trachea",
    respiration: "Respiration",
    cough: "Cough",
    expectoration: "Expectoration",
    chest: "Chest",
    back: "Back",
    extremities: "Extremities",
    sleep: "Sleep",
    chill: "Chill",
    fever: "Fever",
    perspiration: "Perspiration",
    skin: "Skin",
    generalities: "Generalities",
  };

  public static getInstance(): DatasetService {
    if (!DatasetService.instance) {
      DatasetService.instance = new DatasetService();
    }
    return DatasetService.instance;
  }

  public normalizeChapter(raw?: string): string | null {
    if (!raw) return null;
    const lower = raw.trim().toLowerCase();
    return this.chapterMap[lower] || raw.trim();
  }

  public normalizeChapters(raw?: string[] | string): string[] {
    if (!raw) return ["Mind"];

    const allChapters = this.getAvailableChapters();

    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return ["Mind"];
      if (trimmed.toLowerCase() === "all" || trimmed === "*") {
        return allChapters;
      }
      if (trimmed.includes(",")) {
        return this.normalizeChapters(trimmed.split(","));
      }
      const norm = this.normalizeChapter(trimmed);
      return norm ? [norm] : ["Mind"];
    }

    if (Array.isArray(raw)) {
      if (raw.length === 0) return ["Mind"];
      if (raw.some((c) => typeof c === "string" && (c.toLowerCase() === "all" || c === "*"))) {
        return allChapters;
      }

      const resultSet = new Set<string>();
      for (const item of raw) {
        if (typeof item === "string") {
          if (item.includes(",")) {
            const parts = item.split(",");
            for (const p of parts) {
              const norm = this.normalizeChapter(p);
              if (norm) resultSet.add(norm);
            }
          } else {
            const norm = this.normalizeChapter(item);
            if (norm) resultSet.add(norm);
          }
        }
      }

      const result = Array.from(resultSet);
      return result.length > 0 ? result : ["Mind"];
    }

    return ["Mind"];
  }

  public getAvailableChapters(): string[] {
    return Object.values(this.chapterMap);
  }

  public async ensureLoaded(): Promise<void> {
    if (this.isLoaded) return;

    if (!fs.existsSync(CONFIG.jsonlPath)) {
      throw new Error(`Kent repertory dataset not found at ${CONFIG.jsonlPath}`);
    }

    const fileStream = fs.createReadStream(CONFIG.jsonlPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      const item: Rubric = JSON.parse(line);

      this.rubricById.set(item.id, item);
      this.rubricByPath.set(item.rubric_path.toLowerCase(), item);

      // Register parent-child relationship
      const lastArrow = item.rubric_path.lastIndexOf(" > ");
      if (lastArrow !== -1) {
        const parentPath = item.rubric_path.slice(0, lastArrow);
        if (!this.childrenMap.has(parentPath)) {
          this.childrenMap.set(parentPath, []);
        }
        this.childrenMap.get(parentPath)!.push(item);
      }

      // STRICT RULE: No text splitters. Map directly to Document.
      // remedies array is stored in metadata, NEVER in pageContent.
      const doc = new Document<RubricMetadata>({
        pageContent: item.embedding_text || `Kent Repertory | Chapter: ${item.chapter} | Symptom Rubric: ${item.rubric_path}`,
        metadata: {
          id: item.id,
          book: item.book || "Kent's Repertory",
          author: item.author || "J.T. Kent",
          chapter: item.chapter,
          page: item.page,
          source_url: item.source_url,
          depth: item.depth,
          rubric_label: item.rubric_label,
          rubric_path: item.rubric_path,
          cross_references: item.cross_references || [],
          remedy_count: item.remedy_count || 0,
          remedies: item.remedies || [],
        },
      });

      this.allDocuments.push(doc);

      const normChapter = this.normalizeChapter(item.chapter) || item.chapter;
      if (!this.documentsByChapter.has(normChapter)) {
        this.documentsByChapter.set(normChapter, []);
      }
      this.documentsByChapter.get(normChapter)!.push(doc);
    }

    this.isLoaded = true;
  }

  public getDocumentsForChapter(chapter?: string | null): Document<RubricMetadata>[] {
    if (!chapter) {
      return this.allDocuments;
    }
    const norm = this.normalizeChapter(chapter);
    return (norm && this.documentsByChapter.get(norm)) || [];
  }

  public getRubricById(id: string): Rubric | undefined {
    return this.rubricById.get(id);
  }

  public getRubricByPath(rubricPath: string): Rubric | undefined {
    return this.rubricByPath.get(rubricPath.toLowerCase());
  }

  public getImmediateChildren(parentPath: string, parentDepth: number): ChildRubricInfo[] {
    const raw = this.childrenMap.get(parentPath) || [];
    return raw
      .filter((c) => c.depth === parentDepth + 1)
      .map((c) => ({
        id: c.id,
        rubric_label: c.rubric_label,
        rubric_path: c.rubric_path,
        depth: c.depth,
        remedy_count: c.remedy_count,
      }));
  }

  public getTotalRubricsCount(): number {
    return this.rubricById.size;
  }
}
