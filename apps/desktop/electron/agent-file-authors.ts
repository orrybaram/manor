/**
 * Which Agent last wrote each file, from its hooks: Claude's PostToolUse for
 * Edit, Write, MultiEdit and NotebookEdit carries the file it wrote
 * (`filePath`, see `scripts/agent-hook.js`). A file pane asks for a
 * workspace's share of it (`agents.getFileAuthors`) to name the agent beside
 * a changed file and in the conflict banner.
 *
 * Only Claude is attributed. Codex's hooks reach Manor through the same
 * script, but nothing in them names a written file that Manor reads (its
 * edits go through `apply_patch`, whose paths are not passed on); pi's
 * extension sends bare lifecycle events and opencode sends none. Their
 * changes show as unclaimed ("Other changes").
 *
 * In memory only, and only what this server's hooks said: a relaunch leaves
 * a change unattributed. An author is forgotten for a file written again
 * since its hook (by you, or anything else), or deleted. Electron-free, so
 * the host server keeps its own; each answers for files on its own disk.
 *
 * POSIX paths only: a Windows-local path (`C:\…`) is never recorded.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentKind } from "./terminal-host/types";

/** The Agent that last wrote a file: its pane, its kind, and when. */
export interface FileAuthor {
  paneId: string;
  agentKind: AgentKind;
  /** Epoch ms of the hook. */
  at: number;
}

/** The most files remembered; past it, the oldest write is forgotten. */
const MAX_FILES = 5000;

/**
 * How long after its hook a file's mtime may be and still be the agent's
 * write: the hook lands after the write, so only clock slop goes past it.
 */
const WRITE_SLACK_MS = 2000;

type Options = {
  maxFiles?: number;
  /** Whose path rules apply; darwin compares paths case-insensitively. */
  platform?: NodeJS.Platform;
};

export class AgentFileAuthors {
  /** Absolute path → its last author, oldest write first. */
  private readonly byPath = new Map<string, FileAuthor>();
  /** A folder's real path (symlinks resolved), as last found. */
  private readonly realDirs = new Map<string, Promise<string>>();
  private readonly maxFiles: number;
  private readonly foldCase: boolean;

  constructor({ maxFiles = MAX_FILES, platform = process.platform }: Options = {}) {
    this.maxFiles = maxFiles;
    this.foldCase = platform === "darwin";
  }

  /** `author` wrote `filePath`. A relative path names no file we can place; it is dropped. */
  record(filePath: string, author: FileAuthor): void {
    if (!filePath.startsWith("/")) return;
    const key = path.posix.normalize(filePath);
    // Re-inserted, so the map's order stays oldest write first.
    this.byPath.delete(key);
    this.byPath.set(key, author);
    if (this.byPath.size > this.maxFiles) {
      const oldest = this.byPath.keys().next().value;
      if (oldest !== undefined) this.byPath.delete(oldest);
    }
  }

  /**
   * The authors of files under `workspacePath`, keyed by workspace-relative
   * path. Paths match however they were spelled (through a symlink, or in
   * another case on macOS). A file written since its author's hook, or gone,
   * has no author. Only files under the workspace are looked at on disk.
   */
  async inWorkspace(workspacePath: string): Promise<Record<string, FileAuthor>> {
    const root = path.posix.normalize(workspacePath).replace(/\/+$/, "");
    const roots = [...new Set([root, await this.realDir(root)])].map((r) => this.fold(`${r}/`));
    const out: Record<string, FileAuthor> = {};
    await Promise.all(
      [...this.byPath].map(async ([file, author]) => {
        const real = path.posix.join(
          await this.realDir(path.posix.dirname(file)),
          path.posix.basename(file),
        );
        const folded = this.fold(real);
        const prefix = roots.find((r) => folded.startsWith(r));
        if (prefix === undefined) return;
        // Written since (by you, or anything else), or gone: not the agent's now.
        const mtime = await fs.stat(file).then(
          (s) => s.mtimeMs,
          () => null,
        );
        if (mtime === null || mtime > author.at + WRITE_SLACK_MS) return;
        const rel = real.slice(prefix.length);
        // One file under two spellings: the later write is its author.
        if ((out[rel]?.at ?? -Infinity) <= author.at) out[rel] = author;
      }),
    );
    return out;
  }

  /** `dir` with symlinks resolved, or as it is when that fails (a deleted folder). */
  private realDir(dir: string): Promise<string> {
    const known = this.realDirs.get(dir);
    if (known) return known;
    // It only grows with the folders of remembered files and workspaces; past that, start over.
    if (this.realDirs.size > this.maxFiles) this.realDirs.clear();
    const real = fs.realpath(dir).catch(() => {
      // Not kept: the folder may come back.
      this.realDirs.delete(dir);
      return dir;
    });
    this.realDirs.set(dir, real);
    return real;
  }

  private fold(p: string): string {
    return this.foldCase ? p.toLowerCase() : p;
  }
}
