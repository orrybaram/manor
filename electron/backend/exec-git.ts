import { errorMessage } from "../lib/errors";
import type { GitBackend, WorktreeInfo } from "./types";
import { localExec, streamAfter, type Exec, type ExecError, type StreamResult } from "./exec";
import { localFacts, type MachineFacts } from "./machine-facts";

/** Git run through an `Exec`, on whichever machine that reaches (ADR-183). */
export class ExecGitBackend implements GitBackend {
  constructor(
    private readonly execImpl: Exec = localExec,
    /** Joins paths the way the exec's machine does (ADR-183). */
    private readonly facts: MachineFacts = localFacts(),
  ) {}

  private async execGit(
    cwd: string,
    args: string[],
    opts?: { timeout?: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    return this.execImpl.file("git", args, {
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
    try {
      await this.execGit(cwd, args, { timeout: 120000 });
    } catch (err: unknown) {
      throw new Error(parseCommitError(err), { cause: err });
    }
  }

  async stash(cwd: string, files: string[]): Promise<void> {
    await this.execGit(cwd, ["stash", "push", "--", ...files], {
      timeout: 10000,
    });
  }

  pushStream(
    cwd: string,
    opts: { remote?: string; branch?: string; setUpstream?: boolean },
    callbacks: {
      onLine: (line: string) => void;
      onDone: (result: StreamResult) => void;
    },
  ): { cancel: () => void } {
    const push = (branch: string, onDone: (result: StreamResult) => void) => {
      const args: string[] = ["push"];
      if (opts.setUpstream) args.push("--set-upstream");
      args.push(opts.remote ?? "origin", branch);
      // Push progress is newline-terminated.
      return this.gitProgressStream(args, cwd, /\n/, callbacks.onLine, onDone);
    };
    if (opts.branch) return push(opts.branch, callbacks.onDone);
    // Resolving the branch is a command like any other and must go through
    // the injected Exec (for a remote host it runs on the remote).
    const branch = this.execImpl
      .file("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 10000 })
      .then(({ stdout }) => stdout.trim());
    return streamAfter(branch, push, callbacks.onDone);
  }

  cloneStream(
    repoUrl: string,
    targetDir: string,
    callbacks: {
      onLine: (line: string) => void;
      onDone: (result: StreamResult) => void;
    },
  ): { cancel: () => void } {
    // git's clone progress uses `\r` to redraw a line in place, not `\n` —
    // split on either so "Receiving objects: NN%" updates are delivered as
    // they come instead of buffered until the phase changes.
    return this.gitProgressStream(
      ["clone", "--progress", "--", repoUrl, targetDir],
      undefined,
      /\r\n|\r|\n/,
      (line) => {
        if (line.length > 0) callbacks.onLine(line);
      },
      callbacks.onDone,
    );
  }

  /**
   * Run a git command whose progress goes to stderr, handing each line
   * (split on `splitRe`) to `onLine` as it comes and the trailing partial
   * line before `onDone`. A command that never ran (e.g. git missing)
   * reports its reason as the whole of stderr, not as a progress line.
   */
  private gitProgressStream(
    args: string[],
    cwd: string | undefined,
    splitRe: RegExp,
    onLine: (line: string) => void,
    onDone: (result: StreamResult) => void,
  ): { cancel: () => void } {
    let pending = "";
    let stderrFull = "";
    let exited = false;
    return this.execImpl.stream(
      "git",
      args,
      {
        ...(cwd !== undefined ? { cwd } : {}),
        // Overrides only — the Exec merges them onto its own base env. A
        // missing credential must fail fast rather than hang waiting for a
        // prompt Manor cannot answer (ADR-178 §4).
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/true",
        },
      },
      {
        onStderr: (chunk: string) => {
          stderrFull += chunk;
          pending += chunk;
          const parts = pending.split(splitRe);
          // Last element is the trailing partial line (possibly empty).
          pending = parts.pop() ?? "";
          for (const line of parts) onLine(line);
        },
        onExit: ({ exitCode, error }) => {
          if (exited) return;
          exited = true;
          if (error !== undefined) {
            onDone({ exitCode: null, stderr: error });
            return;
          }
          if (pending.length > 0) {
            onLine(pending);
            pending = "";
          }
          onDone({ exitCode, stderr: stderrFull });
        },
      },
    );
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

  async currentBranch(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.execGit(
        repoPath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: 5000 },
      );
      const branch = stdout.trim();
      if (branch && branch !== "HEAD") return branch;

      // Detached HEAD — fall back to a short SHA, sliced to 7 chars to match
      // the local fs-based read in `readLocalBranch`/`readBranchSync`.
      const { stdout: sha } = await this.execGit(
        repoPath,
        ["rev-parse", "HEAD"],
        { timeout: 5000 },
      );
      const trimmed = sha.trim();
      return trimmed ? trimmed.slice(0, 7) : null;
    } catch {
      return null;
    }
  }

  /**
   * Build a synthetic diff for untracked files. Only small text files are
   * read: a binary file, or one of `MAX_UNTRACKED_DIFF_BYTES` or more, is
   * left out without being read.
   */
  private async buildUntrackedDiff(cwd: string): Promise<string> {
    try {
      const { stdout: untrackedOut } = await this.execGit(
        cwd,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        { timeout: 5000 },
      );
      const untrackedFiles = untrackedOut.split("\0").filter(Boolean);
      const readable = await this.smallTextFiles(cwd, untrackedFiles);

      const diffs = await Promise.all(
        untrackedFiles.filter((f) => readable.has(f)).map(async (filePath) => {
          try {
            const content = await this.execImpl.readFile(
              this.facts.join(cwd, filePath),
              "utf-8",
            );
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

  /**
   * Which of `files` (untracked, relative to `cwd`) are regular files under
   * `MAX_UNTRACKED_DIFF_BYTES` that git does not consider binary. Both checks
   * run on the files' own machine, so no content crosses to Manor for them.
   */
  private async smallTextFiles(cwd: string, files: string[]): Promise<Set<string>> {
    const text = new Set<string>();
    for (let i = 0; i < files.length; i += PATH_CHUNK) {
      const chunk = files.slice(i, i + PATH_CHUNK);
      // `-H` follows a symlinked file, as reading it would; `./` keeps a
      // path starting with "-" from reading as an expression.
      const small = await this.outputOf(
        "find",
        ["-H", ...chunk.map((f) => `./${f}`), "-type", "f", "-size", `-${MAX_UNTRACKED_DIFF_BYTES}c`, "-print"],
        cwd,
      );
      const smallFiles = small
        .split("\n")
        .filter((l) => l.startsWith("./"))
        .map((l) => l.slice(2));
      if (smallFiles.length === 0) continue;
      // `-I` skips binary files, and `-L` with a pattern that never matches
      // lists every other one, empty files included.
      const listed = await this.outputOf(
        "git",
        ["--literal-pathspecs", "grep", "--untracked", "-I", "-L", "-z", "-E", "-e", "a^", "--", ...smallFiles],
        cwd,
      );
      for (const f of listed.split("\0")) if (f) text.add(f);
    }
    return text;
  }

  /**
   * A command's stdout, even when it exits non-zero (`find` over a path that
   * vanished, `git grep` listing nothing).
   */
  private async outputOf(cmd: string, args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await this.execImpl.file(cmd, args, { cwd, timeout: 10000 });
      return stdout;
    } catch (err) {
      return (err as Partial<ExecError>).stdout ?? "";
    }
  }
}

/** Untracked files this size or larger are left out of a diff, unread. */
export const MAX_UNTRACKED_DIFF_BYTES = 512 * 1024;

/** Paths per `find`/`git grep` call, to stay well under the argument limit. */
const PATH_CHUNK = 200;

/**
 * Extract a readable summary from a git commit failure.
 * Handles lint-staged output, husky hooks, and plain git errors.
 */
function parseCommitError(err: unknown): string {
  // `Exec.file` rejects with an ExecError; see its doc in exec.ts.
  const execErr = err as Partial<ExecError> | null | undefined;
  const raw = execErr?.stderr || execErr?.stdout || errorMessage(err);

  // Strip the "Command failed: git commit ..." prefix
  const stripped = raw.replace(/^Command failed:[^\n]*\n?/, "");

  // Look for [FAILED] lines from lint-staged
  const failedAgents = stripped
    .split("\n")
    .filter((l: string) => /\[FAILED]/.test(l))
    .map((l: string) => l.replace(/\[FAILED]\s*/, "").trim());

  if (failedAgents.length > 0) {
    // Extract the actual error output: lines after the agent list that aren't
    // lint-staged status markers (e.g. [STARTED], [COMPLETED], etc.)
    const errorLines = stripped
      .split("\n")
      .filter(
        (l: string) =>
          !/^\[(?:STARTED|COMPLETED|FAILED|SKIPPED)]/.test(l.trim()) &&
          !/^npm warn/.test(l.trim()) &&
          l.trim() !== "",
      );

    const summary = `Pre-commit hook failed:\n${failedAgents.map((t: string) => `  - ${t}`).join("\n")}`;
    const detail = errorLines.length > 0 ? `\n\n${errorLines.join("\n")}` : "";
    return summary + detail;
  }

  // Not lint-staged — return a cleaned-up version
  const cleaned = stripped
    .split("\n")
    .filter((l: string) => !/^npm warn/.test(l.trim()))
    .join("\n")
    .trim();

  return cleaned || "Commit failed";
}
