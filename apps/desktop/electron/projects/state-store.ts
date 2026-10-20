/**
 * `projects.json`: loading it, writing it, and batching writes that come in
 * bursts.
 */

import fs from "node:fs";
import path from "node:path";
import { LOCAL_HOST_ID } from "../backend/types";
import { normalizeLinkDismissals } from "./origin-links";
import { normalizeGroups } from "./project-groups";
import type { PersistedProject, PersistedState } from "./types";

export class StateStore {
  readonly state: PersistedState;
  private readonly saveListeners: Array<() => void> = [];

  constructor(private readonly dataDir: string) {
    this.state = this.load();
  }

  private filePath(): string {
    return path.join(this.dataDir, "projects.json");
  }

  /**
   * Every project comes out with a `hostId` — `"local"` where the file has
   * none — so nothing downstream re-defaults it. Linked-project
   * groups and dismissed link suggestions are brought back in line with
   * their invariants; a file without any keeps neither key, so it
   * is written back unchanged.
   */
  private load(): PersistedState {
    let state: PersistedState;
    try {
      state = JSON.parse(fs.readFileSync(this.filePath(), "utf-8"));
    } catch {
      return { projects: [], selectedProjectIndex: 0 };
    }
    for (const project of state.projects as Array<Partial<PersistedProject>>) {
      project.hostId ??= LOCAL_HOST_ID;
    }
    // A host's hook journal is its server's to read: the
    // desktop's position in it is gone.
    for (const host of Object.values(state.hosts ?? {})) {
      delete (host as { lastHookSeq?: number }).lastHookSeq;
      delete (host as { hookJournalEpoch?: string }).hookJournalEpoch;
    }
    if ("groups" in state) normalizeGroups(state);
    if ("dismissedLinkSuggestions" in state) normalizeLinkDismissals(state);
    return state;
  }

  /**
   * Write now. A local project's `hostId` is left out, so its record is
   * byte-for-byte what it was before hosts existed.
   */
  save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(
      this.filePath(),
      JSON.stringify(
        this.state,
        (key, value: unknown) =>
          key === "hostId" && value === LOCAL_HOST_ID ? undefined : value,
        2,
      ),
    );
    for (const listener of this.saveListeners) listener();
  }

  /** Run `listener` after every write. */
  onSave(listener: () => void): void {
    this.saveListeners.push(listener);
  }
}
