/**
 * `projects.json`: loading it, writing it, and batching writes that come in
 * bursts (ADR-183 split this out of `ProjectManager`).
 */

import fs from "node:fs";
import path from "node:path";
import { LOCAL_HOST_ID } from "../backend/types";
import type { PersistedProject, PersistedState } from "./types";

export class StateStore {
  readonly state: PersistedState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly saveListeners: Array<() => void> = [];

  constructor(private readonly dataDir: string) {
    this.state = this.load();
  }

  private filePath(): string {
    return path.join(this.dataDir, "projects.json");
  }

  /**
   * Every project comes out with a `hostId` — `"local"` where the file has
   * none (ADR-183) — so nothing downstream re-defaults it.
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
    return state;
  }

  /**
   * Write now, cancelling any pending `saveSoon`. A local project's
   * `hostId` is left out, so its record is byte-for-byte what it was
   * before hosts existed.
   */
  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
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

  /** Write within `delayMs`, folding every call until then into one write. */
  saveSoon(delayMs: number): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, delayMs);
    this.saveTimer.unref?.();
  }

  /** Write a pending `saveSoon` now; nothing if none is pending. */
  flush(): void {
    if (this.saveTimer) this.save();
  }
}
