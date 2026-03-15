import { describe, test, expect } from "bun:test";
import { readProgress } from "./progress.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmpDir = join(import.meta.dir, "../.test-tmp-progress");

describe("readProgress", () => {
  test("parses valid progress JSON file", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "progress.json");
    const data = {
      status: "done",
      percent_complete: 100,
      current_step: "finished",
      steps_completed: ["step1", "step2"],
      errors: [],
      summary: "All done",
      updated_at: "2026-01-01T00:00:00Z",
    };
    writeFileSync(filePath, JSON.stringify(data));

    const result = await readProgress(filePath);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("done");
    expect(result!.percent_complete).toBe(100);
    expect(result!.steps_completed).toEqual(["step1", "step2"]);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null for missing file", async () => {
    const result = await readProgress("/nonexistent/path/progress.json");
    expect(result).toBeNull();
  });

  test("returns null for invalid JSON", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(filePath, "not valid json {{{");

    const result = await readProgress(filePath);
    expect(result).toBeNull();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
