import { Rubric } from "../types/rubric.types.js";
import { RepertorizeResponse, RankedRemedyItem } from "../types/api.types.js";

export class RepertorizationService {
  private static instance: RepertorizationService;

  public static getInstance(): RepertorizationService {
    if (!RepertorizationService.instance) {
      RepertorizationService.instance = new RepertorizationService();
    }
    return RepertorizationService.instance;
  }

  public calculateMatrix(rubrics: Rubric[]): RepertorizeResponse {
    const remedyMap = new Map<
      string,
      {
        abbr: string;
        full_name: string;
        rubrics_covered: number;
        total_score: number;
        rubric_grades: Record<number, number>;
      }
    >();

    for (let rIdx = 0; rIdx < rubrics.length; rIdx++) {
      const rubric = rubrics[rIdx];
      const remedies = rubric.remedies || [];

      for (const rem of remedies) {
        const abbr = rem.abbr;
        if (!remedyMap.has(abbr)) {
          remedyMap.set(abbr, {
            abbr: rem.abbr,
            full_name: rem.full_name || rem.abbr,
            rubrics_covered: 0,
            total_score: 0,
            rubric_grades: {},
          });
        }

        const entry = remedyMap.get(abbr)!;
        entry.rubrics_covered += 1;
        entry.total_score += rem.grade;
        entry.rubric_grades[rIdx] = rem.grade;
      }
    }

    // STRICT RULE: Deterministic math
    // 1st sort: rubrics_covered desc
    // 2nd sort: total_score desc
    // 3rd sort: full_name asc
    const sorted = Array.from(remedyMap.values()).sort((a, b) => {
      if (b.rubrics_covered !== a.rubrics_covered) {
        return b.rubrics_covered - a.rubrics_covered;
      }
      if (b.total_score !== a.total_score) {
        return b.total_score - a.total_score;
      }
      return a.full_name.localeCompare(b.full_name);
    });

    const ranked_remedies: RankedRemedyItem[] = sorted.map((rem, idx) => ({
      rank: idx + 1,
      abbr: rem.abbr,
      full_name: rem.full_name,
      rubrics_covered: rem.rubrics_covered,
      total_score: rem.total_score,
      rubric_grades: rem.rubric_grades,
    }));

    return {
      rubrics_analyzed: rubrics.length,
      rubrics_summary: rubrics.map((r, idx) => ({
        index: idx,
        path: r.rubric_path,
        page: r.page,
        remedy_count: (r.remedies || []).length,
      })),
      ranked_remedies,
    };
  }
}
