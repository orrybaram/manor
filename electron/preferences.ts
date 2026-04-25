import fs from "node:fs";
import path from "node:path";

import { manorDataDir } from "./paths";

export interface AppPreferences {
  dockBadgeEnabled: boolean;
  notifyOnResponse: boolean;
  notifyOnRequiresInput: boolean;
  notificationSound: string | false;
  defaultEditor: string;
  editorIsTerminal: boolean;
  /**
   * Number of days to retain non-active tasks. Tasks with `status !== "active"`
   * whose `completedAt` is older than this are pruned on TaskManager construction.
   * Set to 0 (or any non-positive number) to disable pruning.
   */
  taskRetentionDays: number;
  /**
   * Set the first time the prune-on-boot path actually deletes any tasks.
   * Used to surface a one-time notice; never reset automatically.
   */
  taskPruneNoticeShown: boolean;
}

const DEFAULTS: AppPreferences = {
  dockBadgeEnabled: true,
  notifyOnResponse: true,
  notifyOnRequiresInput: true,
  notificationSound: "Glass",
  defaultEditor: "",
  editorIsTerminal: false,
  taskRetentionDays: 90,
  taskPruneNoticeShown: false,
};

export class PreferencesManager {
  private dataDir: string;
  private prefs: AppPreferences;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private changeCallback: ((prefs: AppPreferences) => void) | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? manorDataDir();
    this.prefs = this.loadState();
  }

  private prefsFilePath(): string {
    return path.join(this.dataDir, "preferences.json");
  }

  private loadState(): AppPreferences {
    try {
      const data = fs.readFileSync(this.prefsFilePath(), "utf-8");
      const parsed = JSON.parse(data) as Partial<AppPreferences> & {
        notificationSound?: unknown;
      };
      // Migration: convert legacy boolean notificationSound to string | false
      const rawSound = (parsed as Record<string, unknown>).notificationSound;
      if (rawSound === true) {
        parsed.notificationSound = "Glass";
      } else if (rawSound === false) {
        parsed.notificationSound = false;
      }
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
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
        this.prefsFilePath(),
        JSON.stringify(this.prefs, null, 2),
      );
    }, 500);
  }

  get<K extends keyof AppPreferences>(key: K): AppPreferences[K] {
    return this.prefs[key];
  }

  set<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]): void {
    this.prefs[key] = value;
    this.saveState();
    if (this.changeCallback) {
      this.changeCallback({ ...this.prefs });
    }
  }

  getAll(): AppPreferences {
    return { ...this.prefs };
  }

  onChange(callback: (prefs: AppPreferences) => void): void {
    this.changeCallback = callback;
  }
}
