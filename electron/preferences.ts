import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function manorDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Manor");
  }
  return path.join(os.homedir(), ".local", "share", "Manor");
}

export interface AppPreferences {
  dockBadgeEnabled: boolean;
  notifyOnResponse: boolean;
  notifyOnRequiresInput: boolean;
  notificationSound: boolean;
}

const DEFAULTS: AppPreferences = {
  dockBadgeEnabled: true,
  notifyOnResponse: true,
  notifyOnRequiresInput: true,
  notificationSound: true,
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
      const parsed = JSON.parse(data) as Partial<AppPreferences>;
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
