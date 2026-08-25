import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { manorDataDir } from "./paths";

/**
 * Notification persistence model
 *
 * Mirrors the shape and conventions of `task-persistence.ts` (`TaskManager`):
 * in-memory state backed by a JSON file on disk, writes debounced through a
 * single timer, and retention pruning applied at construction and after every
 * append.
 */

export type NotificationKind =
  | "agent-responded"
  | "agent-requires-input"
  | "pr-comment"
  | "pr-approved"
  | "pr-changes-requested"
  | "pr-checks-failed";

export type NotificationTarget =
  | { type: "task"; taskId: string }
  | { type: "url"; url: string };

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  timestamp: string; // ISO
  read: boolean;
  target: NotificationTarget | null;
}

interface PersistedState {
  notifications: NotificationRecord[];
}

/** Hard cap on the number of notifications retained on disk. */
const MAX_NOTIFICATIONS = 200;
/** Notifications older than this are dropped on load and after every append. */
const MAX_AGE_DAYS = 30;

export class NotificationStore {
  private dataDir: string;
  private notifications: NotificationRecord[];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? manorDataDir();
    this.notifications = this.loadState();
    this.prune();
  }

  private notificationsFilePath(): string {
    return path.join(this.dataDir, "notifications.json");
  }

  private loadState(): NotificationRecord[] {
    try {
      const data = fs.readFileSync(this.notificationsFilePath(), "utf-8");
      const state: PersistedState = JSON.parse(data);
      const notifications: NotificationRecord[] = [];
      for (const record of state.notifications ?? []) {
        if (!isValidRecord(record)) continue;
        notifications.push(record);
      }
      return notifications;
    } catch {
      return [];
    }
  }

  private writeStateSync(): void {
    const state: PersistedState = { notifications: this.notifications };
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.notificationsFilePath(), JSON.stringify(state, null, 2));
  }

  private saveState(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeStateSync();
    }, 500);
  }

  /**
   * Writes the current state to disk synchronously, cancelling any pending
   * debounced save.
   */
  flushNow(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeStateSync();
  }

  /**
   * Drops records older than `MAX_AGE_DAYS`, then truncates to the newest
   * `MAX_NOTIFICATIONS`. `this.notifications` is always newest-first, so
   * truncation is a simple slice from the front.
   */
  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    this.notifications = this.notifications.filter((n) => {
      const ms = Date.parse(n.timestamp);
      return Number.isFinite(ms) && ms >= cutoff;
    });
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(0, MAX_NOTIFICATIONS);
    }
  }

  append(input: {
    kind: NotificationKind;
    title: string;
    body: string;
    target: NotificationTarget | null;
  }): NotificationRecord {
    const record: NotificationRecord = {
      id: crypto.randomUUID(),
      kind: input.kind,
      title: input.title,
      body: input.body,
      timestamp: new Date().toISOString(),
      read: false,
      target: input.target,
    };
    this.notifications.unshift(record);
    this.prune();
    this.saveState();
    return record;
  }

  getAll(): NotificationRecord[] {
    return this.notifications;
  }

  getById(id: string): NotificationRecord | null {
    return this.notifications.find((n) => n.id === id) ?? null;
  }

  markRead(id: string): boolean {
    const record = this.notifications.find((n) => n.id === id);
    if (!record || record.read) return false;
    record.read = true;
    this.saveState();
    return true;
  }

  /**
   * Mark every notification pointing at `taskId` read. Called when the user is
   * looking at that task's pane — a notification about a session on screen has
   * already been delivered by the session itself.
   *
   * Returns whether anything actually changed, so the caller can skip the
   * broadcast in the common no-op case.
   */
  markReadByTask(taskId: string): boolean {
    let changed = false;
    for (const record of this.notifications) {
      if (record.read) continue;
      if (record.target?.type !== "task" || record.target.taskId !== taskId) {
        continue;
      }
      record.read = true;
      changed = true;
    }
    if (changed) this.saveState();
    return changed;
  }

  markAllRead(): void {
    for (const record of this.notifications) {
      record.read = true;
    }
    this.saveState();
  }

  clear(): void {
    this.notifications = [];
    this.saveState();
  }

  unreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }
}

function isValidRecord(record: unknown): record is NotificationRecord {
  if (!record || typeof record !== "object") return false;
  const r = record as Partial<NotificationRecord>;
  return (
    typeof r.id === "string" &&
    typeof r.kind === "string" &&
    typeof r.timestamp === "string"
  );
}
