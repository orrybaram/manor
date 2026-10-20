import fs from "node:fs";
import path from "node:path";

import { manorDataDir } from "./paths";

export class KeybindingsManager {
  private dataDir: string;
  private overrides: Record<string, string>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private changeListeners = new Set<
    (overrides: Record<string, string>) => void
  >();

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? manorDataDir();
    this.overrides = this.loadState();
  }

  private keybindingsFilePath(): string {
    return path.join(this.dataDir, "keybindings.json");
  }

  private loadState(): Record<string, string> {
    try {
      const data = fs.readFileSync(this.keybindingsFilePath(), "utf-8");
      const parsed = JSON.parse(data) as Record<string, string>;
      return parsed;
    } catch {
      return {};
    }
  }

  private saveState(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.keybindingsFilePath(),
        JSON.stringify(this.overrides, null, 2),
      );
    }, 500);
  }

  private notifyListeners(): void {
    for (const listener of this.changeListeners) {
      listener({ ...this.overrides });
    }
  }

  getAll(): Record<string, string> {
    return { ...this.overrides };
  }

  set(commandId: string, combo: string): void {
    this.overrides[commandId] = combo;
    this.saveState();
    this.notifyListeners();
  }

  reset(commandId: string): void {
    delete this.overrides[commandId];
    this.saveState();
    this.notifyListeners();
  }

  resetAll(): void {
    this.overrides = {};
    this.saveState();
    this.notifyListeners();
  }

  /**
   * Registers a listener invoked with the full overrides map whenever
   * `set`, `reset`, or `resetAll` runs. Multiple listeners may be
   * registered at once (e.g. the IPC bridge to the renderer and the
   * native menu rebuild). Returns a function that unsubscribes it.
   */
  onChange(callback: (overrides: Record<string, string>) => void): () => void {
    this.changeListeners.add(callback);
    return () => {
      this.changeListeners.delete(callback);
    };
  }
}
