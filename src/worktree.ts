import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";

const SAFE_REF_PATTERN = /^[a-zA-Z0-9_./-]+$/;

function validateGitRef(ref: string): void {
  if (!SAFE_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
}

export function createWorktree(
  repoPath: string,
  branchName: string,
  baseBranch: string,
): string {
  validateGitRef(branchName);
  validateGitRef(baseBranch);

  const repoName = basename(repoPath);
  const worktreeRoot = join(dirname(repoPath), ".worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  const worktreePath = join(
    worktreeRoot,
    `${repoName}-${branchName.replace(/\//g, "-")}`,
  );
  if (existsSync(worktreePath)) {
    return worktreePath;
  }

  execFileSync(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, baseBranch],
    { cwd: repoPath, stdio: "pipe" },
  );

  if (existsSync(join(worktreePath, "package.json"))) {
    execFileSync("bun", ["install"], { cwd: worktreePath, stdio: "pipe" });
  }

  return worktreePath;
}

export function removeWorktree(
  repoPath: string,
  worktreePath: string,
): void {
  execFileSync(
    "git",
    ["worktree", "remove", worktreePath, "--force"],
    { cwd: repoPath, stdio: "pipe" },
  );
}

export function listRepos(workDir: string): string[] {
  const repos: string[] = [];
  try {
    const entries = readdirSync(workDir);
    for (const entry of entries) {
      const fullPath = join(workDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && existsSync(join(fullPath, ".git"))) {
          repos.push(entry);
        }
      } catch {
        // skip inaccessible entries
      }
    }
  } catch {
    // work dir may not exist yet
  }
  return repos;
}

export function findMainWorktree(worktreePath: string): string {
  const gitCommonDir = execFileSync(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
  // git-common-dir returns the .git dir of the main worktree (absolute or relative)
  return resolve(worktreePath, gitCommonDir, "..");
}

export function resolveRepoPath(workDir: string, repoPath: string): string {
  const resolved = resolve(workDir, repoPath);
  if (!resolved.startsWith(resolve(workDir))) {
    throw new Error(`repo_path escapes work directory: ${repoPath}`);
  }
  return resolved;
}
