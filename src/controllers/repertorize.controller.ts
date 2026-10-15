import { Request, Response } from "express";
import { DatasetService } from "../services/dataset.service.js";
import { RepertorizationService } from "../services/repertorization.service.js";
import { RepertorizeRequest } from "../types/api.types.js";
import { Rubric } from "../types/rubric.types.js";

export async function repertorizeHandler(
  req: Request<Record<string, never>, unknown, RepertorizeRequest>,
  res: Response
): Promise<void> {
  try {
    const { rubric_ids, rubric_paths } = req.body;

    if ((!rubric_ids || rubric_ids.length === 0) && (!rubric_paths || rubric_paths.length === 0)) {
      res.status(400).json({ error: "Provide at least one rubric ID in 'rubric_ids' or path in 'rubric_paths'." });
      return;
    }

    const dataset = DatasetService.getInstance();
    await dataset.ensureLoaded();

    const selectedRubrics: Rubric[] = [];

    if (rubric_ids && Array.isArray(rubric_ids)) {
      for (const id of rubric_ids) {
        const r = dataset.getRubricById(id);
        if (r) selectedRubrics.push(r);
      }
    }

    if (rubric_paths && Array.isArray(rubric_paths)) {
      for (const p of rubric_paths) {
        const r = dataset.getRubricByPath(p);
        if (r && !selectedRubrics.some((existing) => existing.id === r.id)) {
          selectedRubrics.push(r);
        }
      }
    }

    if (selectedRubrics.length === 0) {
      res.status(404).json({ error: "None of the specified rubrics were found." });
      return;
    }

    const repertoryService = RepertorizationService.getInstance();
    const result = repertoryService.calculateMatrix(selectedRubrics);

    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to calculate repertorization matrix.", details: msg });
  }
}
