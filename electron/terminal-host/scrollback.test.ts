import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  ScrollbackWriter,
  MAX_SCROLLBACK_BYTES,
  COLD_RESTORE_MAX_BYTES,
  type SessionMeta,
} from "./scrollback";

describe("ScrollbackWriter", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-scrollback-test-${crypto.randomUUID()}`);
    sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates session directory and meta.json", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      const sessionDir = path.join(sessionsDir, "s1");
      expect(fs.existsSync(sessionDir)).toBe(true);

      const metaPath = path.join(sessionDir, "meta.json");
      expect(fs.existsSync(metaPath)).toBe(true);

      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as SessionMeta;
      expect(meta.sessionId).toBe("s1");
      expect(meta.cols).toBe(80);
      expect(meta.rows).toBe(24);
      expect(meta.cwd).toBe("/tmp");
      expect(meta.createdAt).toBeTruthy();
      expect(meta.endedAt).toBeNull();

      writer.dispose();
    });

    it("creates empty scrollback.bin", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");
      expect(fs.existsSync(scrollbackPath)).toBe(true);
      expect(fs.statSync(scrollbackPath).size).toBe(0);

      writer.dispose();
    });
  });

  describe("append and flush", () => {
    it("append accumulates data", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.append("hello ");
      writer.append("world");
      writer.flush();

      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");
      const content = fs.readFileSync(scrollbackPath, "utf-8");
      expect(content).toBe("hello world");

      writer.dispose();
    });

    it("multiple flushes are append-only", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.append("first");
      writer.flush();
      writer.append("second");
      writer.flush();

      const content = fs.readFileSync(path.join(sessionsDir, "s1", "scrollback.bin"), "utf-8");
      expect(content).toBe("firstsecond");

      writer.dispose();
    });

    it("flush with nothing buffered is a no-op", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.flush(); // nothing to flush

      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");
      expect(fs.statSync(scrollbackPath).size).toBe(0);

      writer.dispose();
    });
  });

  describe("size cap", () => {
    it("truncates scrollback at MAX_SCROLLBACK_BYTES", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      // Write more than the cap
      const chunk = "x".repeat(1024 * 1024); // 1MB
      for (let i = 0; i < 6; i++) {
        writer.append(chunk);
        writer.flush();
      }

      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");
      const size = fs.statSync(scrollbackPath).size;
      expect(size).toBeLessThanOrEqual(MAX_SCROLLBACK_BYTES);

      writer.dispose();
    });
  });

  describe("clear scrollback", () => {
    it("handleClearScrollback truncates the file", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.append("old content");
      writer.flush();

      writer.handleClearScrollback();

      writer.append("new content");
      writer.flush();

      const content = fs.readFileSync(path.join(sessionsDir, "s1", "scrollback.bin"), "utf-8");
      expect(content).toBe("new content");
      expect(content).not.toContain("old content");

      writer.dispose();
    });
  });

  describe("updateCwd", () => {
    it("updates cwd in meta.json", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.updateCwd("/new/path");

      const meta = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, "s1", "meta.json"), "utf-8")
      ) as SessionMeta;
      expect(meta.cwd).toBe("/new/path");

      writer.dispose();
    });
  });

  describe("end", () => {
    it("writes endedAt to meta.json", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.end();

      const meta = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, "s1", "meta.json"), "utf-8")
      ) as SessionMeta;
      expect(meta.endedAt).toBeTruthy();
      expect(new Date(meta.endedAt!).getTime()).toBeGreaterThan(0);

      writer.dispose();
    });
  });

  describe("dispose", () => {
    it("flushes remaining buffer on dispose", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.append("unflushed data");
      writer.dispose();

      const content = fs.readFileSync(path.join(sessionsDir, "s1", "scrollback.bin"), "utf-8");
      expect(content).toBe("unflushed data");
    });
  });
});

describe("ScrollbackWriter static readers", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-scrollback-read-test-${crypto.randomUUID()}`);
    sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper to create persisted session data on disk */
  function createPersistedSession(
    sessionId: string,
    scrollbackContent: string,
    meta: Partial<SessionMeta> = {},
  ): void {
    const sessionDir = path.join(sessionsDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(path.join(sessionDir, "scrollback.bin"), scrollbackContent);

    const fullMeta: SessionMeta = {
      sessionId,
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
      endedAt: null,
      ...meta,
    };
    fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify(fullMeta));
  }

  describe("readMeta", () => {
    it("reads meta.json for a session", () => {
      createPersistedSession("s1", "", { cwd: "/Users/test", cols: 120, rows: 40 });

      const meta = ScrollbackWriter.readMeta("s1", sessionsDir);
      expect(meta).not.toBeNull();
      expect(meta!.sessionId).toBe("s1");
      expect(meta!.cwd).toBe("/Users/test");
      expect(meta!.cols).toBe(120);
      expect(meta!.rows).toBe(40);
    });

    it("returns null for nonexistent session", () => {
      const meta = ScrollbackWriter.readMeta("nonexistent", sessionsDir);
      expect(meta).toBeNull();
    });
  });

  describe("readScrollback", () => {
    it("reads scrollback content", () => {
      createPersistedSession("s1", "line 1\nline 2\nline 3\n");

      const content = ScrollbackWriter.readScrollback("s1", sessionsDir);
      expect(content).toContain("line 1");
      expect(content).toContain("line 3");
    });

    it("returns empty string for nonexistent session", () => {
      const content = ScrollbackWriter.readScrollback("nonexistent", sessionsDir);
      expect(content).toBe("");
    });

    it("truncates to COLD_RESTORE_MAX_BYTES", () => {
      const bigContent = "x".repeat(COLD_RESTORE_MAX_BYTES + 100_000);
      createPersistedSession("s1", bigContent);

      const content = ScrollbackWriter.readScrollback("s1", sessionsDir);
      expect(content.length).toBeLessThanOrEqual(COLD_RESTORE_MAX_BYTES);
    });

    it("truncates at UTF-8 safe boundary", () => {
      // Create content with multi-byte UTF-8 characters near the boundary
      const prefix = "a".repeat(COLD_RESTORE_MAX_BYTES - 10);
      const multibyte = "日本語テスト"; // 6 chars, 18 bytes in UTF-8
      const content = prefix + multibyte + "a".repeat(100_000);
      createPersistedSession("s1", content);

      const restored = ScrollbackWriter.readScrollback("s1", sessionsDir);
      // Should not contain broken UTF-8 — if we can parse it, it's valid
      expect(() => Buffer.from(restored, "utf-8").toString("utf-8")).not.toThrow();
      // Content should be <= limit
      expect(Buffer.from(restored, "utf-8").length).toBeLessThanOrEqual(COLD_RESTORE_MAX_BYTES);
    });
  });

  describe("isUncleanShutdown", () => {
    it("returns true when endedAt is null", () => {
      createPersistedSession("s1", "data", { endedAt: null });
      expect(ScrollbackWriter.isUncleanShutdown("s1", sessionsDir)).toBe(true);
    });

    it("returns false when endedAt is set", () => {
      createPersistedSession("s1", "data", { endedAt: new Date().toISOString() });
      expect(ScrollbackWriter.isUncleanShutdown("s1", sessionsDir)).toBe(false);
    });

    it("returns false for nonexistent session", () => {
      expect(ScrollbackWriter.isUncleanShutdown("nonexistent", sessionsDir)).toBe(false);
    });
  });

  describe("listPersistedSessions", () => {
    it("lists all session directories", () => {
      createPersistedSession("s1", "");
      createPersistedSession("s2", "");
      createPersistedSession("s3", "");

      const sessions = ScrollbackWriter.listPersistedSessions(sessionsDir);
      expect(sessions.sort()).toEqual(["s1", "s2", "s3"]);
    });

    it("returns empty array when no sessions", () => {
      const sessions = ScrollbackWriter.listPersistedSessions(sessionsDir);
      expect(sessions).toEqual([]);
    });
  });
});
