import { Request, Response } from "express";
import { DatasetService } from "../services/dataset.service.js";
import { ClinicalService } from "../services/clinical.service.js";
import { ClarifyRequest, ClarifyResponse } from "../types/api.types.js";
import { Rubric } from "../types/rubric.types.js";

export async function clarifyHandler(
  req: Request<Record<string, never>, unknown, ClarifyRequest>,
  res: Response
): Promise<void> {
  try {
    const { rubric_id, rubric_path } = req.body;

    if (!rubric_id && !rubric_path) {
      res.status(400).json({ error: "Provide either 'rubric_id' or 'rubric_path' to clarify." });
      return;
    }

    const dataset = DatasetService.getInstance();
    await dataset.ensureLoaded();

    let targetRubric: Rubric | undefined;
    if (rubric_id) {
      targetRubric = dataset.getRubricById(rubric_id);
    } else if (rubric_path) {
      targetRubric = dataset.getRubricByPath(rubric_path);
    }

    if (!targetRubric) {
      res.status(404).json({ error: "Rubric not found in dataset." });
      return;
    }

    // Inspect child sub-rubrics
    let children = dataset.getImmediateChildren(targetRubric.rubric_path, targetRubric.depth);
    let contextualRubric = targetRubric;

    // If leaf rubric, check direct parent to get sibling modalities
    if (children.length === 0) {
      const lastArrow = targetRubric.rubric_path.lastIndexOf(" > ");
      if (lastArrow !== -1) {
        const parentPath = targetRubric.rubric_path.slice(0, lastArrow);
        const parent = dataset.getRubricByPath(parentPath);
        if (parent) {
          const parentChildren = dataset.getImmediateChildren(parent.rubric_path, parent.depth);
          if (parentChildren.length > 0) {
            contextualRubric = parent;
            children = parentChildren;
          }
        }
      }
    }

    const clinical = ClinicalService.getInstance();
    const clarifying_questions = await clinical.generateClarifyingQuestions(contextualRubric, children);

    const response: ClarifyResponse = {
      rubric_path: contextualRubric.rubric_path,
      chapter: contextualRubric.chapter,
      page: contextualRubric.page,
      child_sub_rubrics: children.map((c) => ({
        label: c.rubric_label,
        remedies_count: c.remedy_count,
      })),
      clarifying_questions,
    };

    res.json(response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to generate clarifying questions.", details: msg });
  }
}
