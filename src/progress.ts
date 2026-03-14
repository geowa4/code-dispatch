import { readFile } from "node:fs/promises";

export interface ProgressReport {
  status: "running" | "done" | "error";
  percent_complete: number;
  current_step: string;
  steps_completed: string[];
  errors: string[];
  summary: string;
  updated_at: string;
}

export async function readProgress(
  progressFile: string,
): Promise<ProgressReport | null> {
  try {
    const raw = await readFile(progressFile, "utf-8");
    return JSON.parse(raw) as ProgressReport;
  } catch {
    return null;
  }
}
