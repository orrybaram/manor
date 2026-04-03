import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitBackend, WorktreeInfo } from "./types";
import { execFileAsync } from "./exec";

export class LocalGitBackend implements GitBackend {
  private async execGit(
    cwd: string,
    args: string[],
    opts?: { timeout?: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, {
      cwd,
      timeout: opts?.timeout ?? 30000,
      maxBuffer: opts?.maxBuffer,
    });
  }

  async exec(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await this.execGit(cwd, args);
    return stdout;
  }

  async stage(cwd: string, files: string[]): Promise<void> {
    await this.execGit(cwd, ["add", "--", ...files], { timeout: 10000 });
  }

  async unstage(cwd: string, files: string[]): Promise<void> {
    await this.execGit(cwd, ["restore", "--staged", "--", ...files], {
      timeout: 10000,
    });
  }

  async discard(cwd: string, files: string[]): Promise<void> {
    // Checkout tracked files (ignore errors — some may be untracked)
    try {
      await this.execGit(cwd, ["checkout", "HEAD", "--", ...files], {
        timeout: 10000,
      });
    } catch {
      /* some files may be untracked */
    }
    // Clean untracked files (ignore errors — some may not be untracked)
    try {
      await this.execGit(cwd, ["clean", "-f", "--", ...files], {
        timeout: 10000,
      });
    } catch {
      /* some files may not be untracked */
    }
  }

  async commit(cwd: string, message: string, flags: string[]): Promise<void> {
    const allowedFlags = ["--amend", "--no-verify", "--allow-empty"];
    const safeFlags = flags.filter((f) => allowedFlags.includes(f));
    const hasMessage = typeof message === "string" && message.length > 0;
    const isAmend = safeFlags.includes("--amend");
    if (!hasMessage && !isAmend) {
      throw new Error("Commit message is required for non-amend commits");
    }
    const args = [
      "commit",
      ...safeFlags,
      ...(hasMessage ? ["-m", message] : ["--no-edit"]),
    ];
    await this.execGit(cwd, args, { timeout: 30000 });
  }

  async stash(cwd: string, files: string[]): Promise<void> {
    await this.execGit(cwd, ["stash", "push", "--", ...files], {
      timeout: 10000,
    });
  }

  async getFullDiff(
    cwd: string,
    defaultBranch: string,
  ): Promise<string | null> {
    const refs = [`origin/${defaultBranch}`, defaultBranch];
    for (const ref of refs) {
      try {
        const { stdout: mergeBaseOut } = await this.execGit(
          cwd,
          ["merge-base", ref, "HEAD"],
          { timeout: 5000 },
        );
        const mergeBase = mergeBaseOut.trim();
        const { stdout } = await this.execGit(
          cwd,
          ["diff", "--no-color", mergeBase],
          { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
        );

        const untrackedDiff = await this.buildUntrackedDiff(cwd);
        return stdout + untrackedDiff;
      } catch {
        continue;
      }
    }
    return null;
  }

  async getLocalDiff(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await this.execGit(
        cwd,
        ["diff", "--no-color", "HEAD"],
        { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      );

      const untrackedDiff = await this.buildUntrackedDiff(cwd);
      const result = stdout + untrackedDiff;
      return result.trim() === "" ? null : result;
    } catch {
      return null;
    }
  }

  async getStagedFiles(cwd: string): Promise<string[]> {
    try {
      const { stdout } = await this.execGit(
        cwd,
        ["diff", "--cached", "--name-only"],
        { timeout: 10000 },
      );
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async worktreeList(cwd: string): Promise<WorktreeInfo[]> {
    const { stdout } = await this.execGit(
      cwd,
      ["worktree", "list", "--porcelain"],
      { timeout: 5000 },
    );

    const workspaces: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";
    let isFirst = true;

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (currentPath) {
          workspaces.push({
            path: currentPath,
            branch: currentBranch,
            isMain: isFirst,
          });
          isFirst = false;
        }
        currentPath = line.slice(9);
        currentBranch = "";
      } else if (line.startsWith("branch refs/heads/")) {
        currentBranch = line.slice(18);
      } else if (line === "" && currentPath) {
        workspaces.push({
          path: currentPath,
          branch: currentBranch,
          isMain: isFirst,
        });
        isFirst = false;
        currentPath = "";
        currentBranch = "";
      }
    }

    if (currentPath) {
      workspaces.push({
        path: currentPath,
        branch: currentBranch,
        isMain: isFirst,
      });
    }

    return workspaces;
  }

  async worktreeAdd(
    cwd: string,
    wtPath: string,
    branch: string,
    opts?: { createBranch?: boolean; startPoint?: string },
  ): Promise<void> {
    const args = ["worktree", "add", wtPath];
    if (opts?.createBranch) {
      args.push("-b", branch);
      if (opts.startPoint) {
        args.push(opts.startPoint);
      }
    } else {
      args.push(branch);
    }
    await this.execGit(cwd, args, { timeout: 15000 });
  }

  async worktreeRemove(
    cwd: string,
    wtPath: string,
    force?: boolean,
  ): Promise<void> {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(wtPath);
    await this.execGit(cwd, args, { timeout: 300_000 });
  }

  private async buildUntrackedDiff(cwd: string): Promise<string> {
    try {
      const { stdout: untrackedOut } = await this.execGit(
        cwd,
        ["ls-files", "--others", "--exclude-standard"],
        { timeout: 5000 },
      );
      const untrackedFiles = untrackedOut.trim().split("\n").filter(Boolean);

      const diffs = await Promise.all(
        untrackedFiles.map(async (filePath) => {
          try {
            const content = await readFile(path.join(cwd, filePath), "utf-8");
            const lines = content.split("\n");
            if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
            const hunk = `@@ -0,0 +1,${lines.length} @@`;
            const addedLines = lines.map((l) => `+${l}`).join("\n");
            return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n${hunk}\n${addedLines}\n`;
          } catch {
            return "";
          }
        }),
      );

      return diffs.join("");
    } catch {
      return "";
    }
  }
}
