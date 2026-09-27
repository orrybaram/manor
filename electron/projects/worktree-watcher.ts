/**
 * Watches local projects' `.git/worktrees/` so a worktree made or removed
 * outside Manor — an agent running `git worktree add` in its shell — reaches
 * the sidebar without a restart. Mutations that go through Manor already tell
 * the renderer; this catches the ones that never do.
 *
 * Remote projects are not watched: their git directory is on another machine.
 */

import fs from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 300;

/**
 * The git directory shared by every worktree of the repo at `projectPath`, or
 * null when it is not a git repo. `.git` is a directory for a normal clone and
 * a `gitdir:` file when the project is itself a linked worktree.
 */
export function gitCommonDir(projectPath: string): string | null {
  const dotGit = path.join(projectPath, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf-8"));
    if (!match) return null;
    const gitDir = path.resolve(projectPath, match[1].trim());
    const commonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
    return path.resolve(gitDir, commonDir);
  } catch {
    return null;
  }
}

/** One project's watches: `.git` for `worktrees/` appearing, `worktrees/` for its entries. */
class RepoWatch {
  private gitWatcher: fs.FSWatcher | null = null;
  private worktreesWatcher: fs.FSWatcher | null = null;

  constructor(
    private readonly commonDir: string,
    private readonly onChange: () => void,
  ) {
    // `worktrees/` only exists once the repo has had a linked worktree, and
    // git deletes it again when the last one goes — so watch its parent for
    // it coming and going, and re-attach to it each time.
    try {
      this.gitWatcher = fs.watch(commonDir, (_event, filename) => {
        if (filename === "worktrees") {
          this.attachWorktrees();
          this.onChange();
        }
      });
      this.gitWatcher.on("error", () => this.close());
    } catch {
      // Unwatchable (permissions, vanished) — the focus refetch still covers it.
    }
    this.attachWorktrees();
  }

  private attachWorktrees(): void {
    this.worktreesWatcher?.close();
    this.worktreesWatcher = null;
    try {
      this.worktreesWatcher = fs.watch(path.join(this.commonDir, "worktrees"), () =>
        this.onChange(),
      );
      this.worktreesWatcher.on("error", () => {
        this.worktreesWatcher?.close();
        this.worktreesWatcher = null;
      });
    } catch {
      // No `worktrees/` yet; the `.git` watch attaches once it appears.
    }
  }

  close(): void {
    this.gitWatcher?.close();
    this.worktreesWatcher?.close();
    this.gitWatcher = null;
    this.worktreesWatcher = null;
  }
}

export class WorktreeWatcher {
  private readonly repos = new Map<string, RepoWatch>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `onChange` runs once per burst of worktree changes, across all projects. */
  constructor(private readonly onChange: () => void) {}

  /** Watch exactly the repos behind `projectPaths`, starting and stopping watches to match. */
  sync(projectPaths: string[]): void {
    const wanted = new Set<string>();
    for (const projectPath of projectPaths) {
      const commonDir = gitCommonDir(projectPath);
      if (commonDir) wanted.add(commonDir);
    }
    for (const [dir, watch] of this.repos) {
      if (!wanted.has(dir)) {
        watch.close();
        this.repos.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (!this.repos.has(dir)) {
        this.repos.set(dir, new RepoWatch(dir, () => this.schedule()));
      }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watch of this.repos.values()) watch.close();
    this.repos.clear();
  }
}
