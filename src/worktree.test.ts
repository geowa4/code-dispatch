import { describe, test, expect } from "bun:test";
import { listRepos, resolveRepoPath } from "./worktree.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmpDir = join(import.meta.dir, "../.test-tmp-worktree");

describe("listRepos", () => {
  test("returns repo names for directories with .git", () => {
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(tmpDir, "repo-b", ".git"), { recursive: true });
    mkdirSync(join(tmpDir, "not-a-repo"), { recursive: true });

    const repos = listRepos(tmpDir);

    expect(repos).toContain("repo-a");
    expect(repos).toContain("repo-b");
    expect(repos).not.toContain("not-a-repo");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for empty directory", () => {
    mkdirSync(tmpDir, { recursive: true });

    const repos = listRepos(tmpDir);
    expect(repos).toEqual([]);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for non-existent directory", () => {
    const repos = listRepos("/nonexistent/path/xyz");
    expect(repos).toEqual([]);
  });
});

describe("resolveRepoPath", () => {
  test("resolves valid relative path within work dir", () => {
    const result = resolveRepoPath("/home/work", "my-repo");
    expect(result).toBe("/home/work/my-repo");
  });

  test("rejects path traversal escaping work dir", () => {
    expect(() => resolveRepoPath("/home/work", "../../etc")).toThrow(
      "repo_path escapes work directory",
    );
  });

  test("rejects absolute path outside work dir", () => {
    expect(() => resolveRepoPath("/home/work", "/etc/passwd")).toThrow(
      "repo_path escapes work directory",
    );
  });
});
