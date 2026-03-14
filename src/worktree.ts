import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";

export function createWorktree(
  repoPath: string,
  branchName: string,
  baseBranch: string,
): string {
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

  execSync(
    `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`,
    { cwd: repoPath, stdio: "pipe" },
  );

  if (existsSync(join(worktreePath, "package.json"))) {
    execSync("bun install", { cwd: worktreePath, stdio: "pipe" });
  }

  return worktreePath;
}

export function removeWorktree(
  repoPath: string,
  worktreePath: string,
): void {
  execSync(`git worktree remove "${worktreePath}" --force`, {
    cwd: repoPath,
    stdio: "pipe",
  });
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
