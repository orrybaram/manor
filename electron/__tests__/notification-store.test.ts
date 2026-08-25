import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { NotificationStore } from "../notification-store";
import type { NotificationRecord } from "../notification-store";

describe("NotificationStore", () => {
  let tmpDir: string;
  let store: NotificationStore;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-notification-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new NotificationStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function append(overrides: Partial<Parameters<NotificationStore["append"]>[0]> = {}) {
    return store.append({
      kind: "agent-responded",
      title: "Agent responded",
      body: "Task finished",
      target: null,
      ...overrides,
    });
  }

  it("append → getAll returns newest-first", () => {
    const first = append({ title: "first" });
    const second = append({ title: "second" });
    const third = append({ title: "third" });

    const all = store.getAll();
    expect(all.map((n) => n.id)).toEqual([third.id, second.id, first.id]);
  });

  it("append generates an id and timestamp and defaults read to false", () => {
    const record = append();
    expect(record.id).toBeTruthy();
    expect(record.read).toBe(false);
    expect(() => new Date(record.timestamp).toISOString()).not.toThrow();
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
  });

  it("getById finds a record by id, null for unknown", () => {
    const record = append();
    expect(store.getById(record.id)).toEqual(record);
    expect(store.getById("unknown-id")).toBeNull();
  });

  it("markRead flips exactly one record and returns false for an unknown id", () => {
    const a = append({ title: "a" });
    const b = append({ title: "b" });

    expect(store.markRead("unknown-id")).toBe(false);

    expect(store.markRead(a.id)).toBe(true);
    expect(store.getById(a.id)?.read).toBe(true);
    expect(store.getById(b.id)?.read).toBe(false);

    // Marking an already-read record again returns false (no change).
    expect(store.markRead(a.id)).toBe(false);
  });

  it("markAllRead marks every record read", () => {
    append();
    append();
    append();

    expect(store.unreadCount()).toBe(3);
    store.markAllRead();
    expect(store.unreadCount()).toBe(0);
    expect(store.getAll().every((n) => n.read)).toBe(true);
  });

  it("markReadByTask reads only the records pointing at that task", () => {
    const mine = append({ target: { type: "task", taskId: "t1" } });
    const other = append({ target: { type: "task", taskId: "t2" } });
    const urlRecord = append({
      target: { type: "url", url: "https://example.test/pull/1" },
    });

    expect(store.markReadByTask("t1")).toBe(true);
    expect(store.getById(mine.id)?.read).toBe(true);
    expect(store.getById(other.id)?.read).toBe(false);
    expect(store.getById(urlRecord.id)?.read).toBe(false);
    expect(store.unreadCount()).toBe(2);
  });

  it("markReadByTask reports no change when nothing is left unread", () => {
    append({ target: { type: "task", taskId: "t1" } });
    expect(store.markReadByTask("t1")).toBe(true);
    expect(store.markReadByTask("t1")).toBe(false);
    expect(store.markReadByTask("never-seen")).toBe(false);
  });

  it("clear empties the store", () => {
    append();
    append();
    store.clear();
    expect(store.getAll()).toEqual([]);
    expect(store.unreadCount()).toBe(0);
  });

  it("unreadCount reflects only unread records", () => {
    const a = append();
    append();
    store.markRead(a.id);
    expect(store.unreadCount()).toBe(1);
  });

  it("prunes to the newest 200 records when the cap is exceeded", () => {
    for (let i = 0; i < 205; i++) {
      append({ title: `notif-${i}` });
    }
    const all = store.getAll();
    expect(all.length).toBe(200);
    // Newest-first: the most recently appended survive.
    expect(all[0].title).toBe("notif-204");
    expect(all[all.length - 1].title).toBe("notif-5");
  });

  it("prunes records older than the 30-day boundary", () => {
    store.flushNow();

    const oldRecord: NotificationRecord = {
      id: crypto.randomUUID(),
      kind: "agent-responded",
      title: "old",
      body: "old body",
      timestamp: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      read: false,
      target: null,
    };
    const borderlineRecord: NotificationRecord = {
      id: crypto.randomUUID(),
      kind: "agent-responded",
      title: "borderline",
      body: "borderline body",
      timestamp: new Date(Date.now() - 29 * 86_400_000).toISOString(),
      read: false,
      target: null,
    };

    fs.writeFileSync(
      path.join(tmpDir, "notifications.json"),
      JSON.stringify({ notifications: [borderlineRecord, oldRecord] }, null, 2),
    );

    const reloaded = new NotificationStore(tmpDir);
    const ids = reloaded.getAll().map((n) => n.id);
    expect(ids).toContain(borderlineRecord.id);
    expect(ids).not.toContain(oldRecord.id);
  });

  it("reload from disk round-trips records", async () => {
    const record = append({ title: "persisted" });
    store.flushNow();

    const reloaded = new NotificationStore(tmpDir);
    expect(reloaded.getAll()).toEqual([record]);
  });

  it("a corrupt notifications.json yields an empty store instead of throwing", () => {
    fs.writeFileSync(path.join(tmpDir, "notifications.json"), "{ not valid json");

    expect(() => new NotificationStore(tmpDir)).not.toThrow();
    const corrupted = new NotificationStore(tmpDir);
    expect(corrupted.getAll()).toEqual([]);
  });

  it("drops records that fail the minimal shape check", () => {
    fs.writeFileSync(
      path.join(tmpDir, "notifications.json"),
      JSON.stringify({
        notifications: [
          { id: "1", kind: "agent-responded", timestamp: new Date().toISOString(), title: "ok", body: "", read: false, target: null },
          { kind: "agent-responded", timestamp: new Date().toISOString() }, // missing id
          { id: "3", timestamp: new Date().toISOString() }, // missing kind
          { id: "4", kind: "agent-responded" }, // missing timestamp
        ],
      }),
    );

    const reloaded = new NotificationStore(tmpDir);
    expect(reloaded.getAll().map((n) => n.id)).toEqual(["1"]);
  });
});
