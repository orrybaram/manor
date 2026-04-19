import fs from "node:fs";
import path from "node:path";

import { manorDataDir } from "./paths";

export class KeybindingsManager {
  private dataDir: string;
  private overrides: Record<string, string>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private changeCallback: ((overrides: Record<string, string>) => void) | null =
    null;

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

  getAll(): Record<string, string> {
    return { ...this.overrides };
  }

  set(commandId: string, combo: string): void {
    this.overrides[commandId] = combo;
    this.saveState();
    if (this.changeCallback) {
      this.changeCallback({ ...this.overrides });
    }
  }

  reset(commandId: string): void {
    delete this.overrides[commandId];
    this.saveState();
    if (this.changeCallback) {
      this.changeCallback({ ...this.overrides });
    }
  }

  resetAll(): void {
    this.overrides = {};
    this.saveState();
    if (this.changeCallback) {
      this.changeCallback({ ...this.overrides });
    }
  }

  onChange(callback: (overrides: Record<string, string>) => void): void {
    this.changeCallback = callback;
  }
}
