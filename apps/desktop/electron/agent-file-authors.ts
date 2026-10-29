/**
 * Which Agent last wrote each file, from its hooks: Claude's PostToolUse for
 * Edit, Write, MultiEdit and NotebookEdit carries the file it wrote
 * (`filePath`, see `scripts/agent-hook.js`). A file pane asks for a
 * workspace's share of it (`agents.getFileAuthors`) to name the agent beside
 * a changed file and in the conflict banner.
 *
 * In memory only, and only what this server's hooks said: a relaunch, or an
 * agent kind whose hooks name no file, leaves a change unattributed.
 * Electron-free, so the host server keeps its own.
 */

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

export class AgentFileAuthors {
  /** Absolute path → its last author, oldest write first. */
  private readonly byPath = new Map<string, FileAuthor>();

  constructor(private readonly maxFiles = MAX_FILES) {}

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

  /** The authors of files under `workspacePath`, keyed by workspace-relative path. */
  inWorkspace(workspacePath: string): Record<string, FileAuthor> {
    const root = path.posix.normalize(workspacePath).replace(/\/+$/, "");
    const prefix = `${root}/`;
    const out: Record<string, FileAuthor> = {};
    for (const [file, author] of this.byPath) {
      if (file.startsWith(prefix)) out[file.slice(prefix.length)] = author;
    }
    return out;
  }
}
