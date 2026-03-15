import { readFile } from "node:fs/promises";
import { z } from "zod";

const progressSchema = z.object({
  status: z.enum(["running", "done", "error"]),
  percent_complete: z.number(),
  current_step: z.string(),
  steps_completed: z.array(z.string()),
  errors: z.array(z.string()),
  summary: z.string(),
  updated_at: z.string(),
});

export type ProgressReport = z.infer<typeof progressSchema>;

export async function readProgress(
  progressFile: string,
): Promise<ProgressReport | null> {
  try {
    const raw = await readFile(progressFile, "utf-8");
    const parsed = JSON.parse(raw);
    return progressSchema.parse(parsed);
  } catch {
    return null;
  }
}
