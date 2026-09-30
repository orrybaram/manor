import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  ScrollbackWriter,
  isSafeSessionId,
  MAX_SCROLLBACK_BYTES,
  SCROLLBACK_TRUNCATE_TO_BYTES,
  COLD_RESTORE_MAX_BYTES,
  type SessionMeta,
} from "./scrollback";

describe("ScrollbackWriter", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-scrollback-test-${crypto.randomUUID()}`,
    );
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

      const meta = JSON.parse(
        fs.readFileSync(metaPath, "utf-8"),
      ) as SessionMeta;
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
    it("append accumulates data", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.append("hello ");
      writer.append("world");
      await writer.flush();

      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");
      const content = fs.readFileSync(scrollbackPath, "utf-8");
      expect(content).toBe("hello world");

      writer.dispose();
    });

    it("multiple flushes are append-only", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.append("first");
      await writer.flush();
      writer.append("second");
      await writer.flush();

      const content = fs.readFileSync(
        path.join(sessionsDir, "s1", "scrollback.bin"),
        "utf-8",
      );
      expect(content).toBe("firstsecond");

      writer.dispose();
    });

    it("flush with nothing buffered is a no-op", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      await writer.flush(); // nothing to flush

      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");
      expect(fs.statSync(scrollbackPath).size).toBe(0);

      writer.dispose();
    });
  });

  describe("size cap", () => {
    it("truncates scrollback at MAX_SCROLLBACK_BYTES", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      // Write more than the cap
      const chunk = "x".repeat(1024 * 1024); // 1MB
      for (let i = 0; i < 6; i++) {
        writer.append(chunk);
        await writer.flush();
      }

      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");
      const size = fs.statSync(scrollbackPath).size;
      expect(size).toBeLessThanOrEqual(MAX_SCROLLBACK_BYTES);

      writer.dispose();
    });
  });

  describe("past the cap", () => {
    const scrollbackPath = () => path.join(sessionsDir, "s1", "scrollback.bin");

    it("cuts back to half the cap and keeps the newest output", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      const chunk = "x".repeat(1024 * 1024);
      for (let i = 0; i < 5; i++) {
        writer.append(chunk);
        await writer.flush();
      }
      writer.append("newest output");
      await writer.flush();

      const content = fs.readFileSync(scrollbackPath(), "utf-8");
      expect(content.length).toBeLessThanOrEqual(SCROLLBACK_TRUNCATE_TO_BYTES);
      expect(content.endsWith("newest output")).toBe(true);

      writer.dispose();
    });

    it("does not rewrite the file on every flush once past it", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      const mb = "x".repeat(1024 * 1024);
      for (let i = 0; i < 6; i++) {
        writer.append(mb);
        await writer.flush();
      }
      // A truncation swaps a new file in, so the inode tells rewrites apart
      // from appends.
      const { ino, size } = fs.statSync(scrollbackPath());

      const flush = "y".repeat(ScrollbackWriter.FLUSH_THRESHOLD_BYTES);
      for (let i = 1; i <= 8; i++) {
        writer.append(flush);
        await writer.flush();
        const stat = fs.statSync(scrollbackPath());
        expect(stat.ino).toBe(ino);
        expect(stat.size).toBe(size + i * flush.length);
      }

      writer.dispose();
    });

    it("cuts at a UTF-8 boundary", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      const chunk = "日本語".repeat(120_000); // ~1 MB of 3-byte characters
      for (let i = 0; i < 6; i++) {
        writer.append(chunk);
        await writer.flush();
      }

      const bytes = fs.readFileSync(scrollbackPath());
      expect(bytes[0] & 0xc0).not.toBe(0x80);
      expect(bytes.toString("utf-8")).not.toContain("\uFFFD");

      writer.dispose();
    });
  });

  describe("off the event loop", () => {
    it("flush writes asynchronously", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });
      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");

      writer.append("output");
      const flushed = writer.flush();
      expect(fs.statSync(scrollbackPath).size).toBe(0);
      await flushed;
      expect(fs.readFileSync(scrollbackPath, "utf-8")).toBe("output");

      writer.dispose();
    });

    it("clear-scrollback truncates asynchronously", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });
      const scrollbackPath = path.join(sessionsDir, "s1", "scrollback.bin");
      writer.append("old");
      await writer.flush();

      const cleared = writer.handleClearScrollback();
      expect(fs.readFileSync(scrollbackPath, "utf-8")).toBe("old");
      await cleared;
      expect(fs.statSync(scrollbackPath).size).toBe(0);

      writer.dispose();
    });
  });

  describe("clear scrollback", () => {
    it("handleClearScrollback truncates the file", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.append("old content");
      await writer.flush();

      await writer.handleClearScrollback();

      writer.append("new content");
      await writer.flush();

      const content = fs.readFileSync(
        path.join(sessionsDir, "s1", "scrollback.bin"),
        "utf-8",
      );
      expect(content).toBe("new content");
      expect(content).not.toContain("old content");

      writer.dispose();
    });
  });

  describe("updateCwd", () => {
    it("updates cwd in meta.json", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      await writer.updateCwd("/new/path");

      const meta = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, "s1", "meta.json"), "utf-8"),
      ) as SessionMeta;
      expect(meta.cwd).toBe("/new/path");

      writer.dispose();
    });
  });

  describe("updateCwd on every prompt", () => {
    const metaPath = () => path.join(sessionsDir, "s1", "meta.json");
    const readMeta = () =>
      JSON.parse(fs.readFileSync(metaPath(), "utf-8")) as SessionMeta;

    it("writes asynchronously", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      const updated = writer.updateCwd("/new/path");
      expect(readMeta().cwd).toBe("/tmp");
      await updated;
      expect(readMeta().cwd).toBe("/new/path");

      writer.dispose();
    });

    it("writes nothing when the cwd did not change", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });
      fs.rmSync(metaPath());

      await writer.updateCwd("/tmp");
      expect(fs.existsSync(metaPath())).toBe(false);

      writer.dispose();
    });

    it("lands the last of a burst of changes", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      for (let i = 0; i < 20; i++) void writer.updateCwd(`/dir/${i}`);
      await writer.whenIdle();
      expect(readMeta().cwd).toBe("/dir/19");

      writer.dispose();
    });

    it("swaps meta.json in whole rather than writing it in place", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });
      const { ino } = fs.statSync(metaPath());

      await writer.updateCwd("/new/path");

      // A rename puts a new inode in place; an in-place write keeps the old one.
      expect(fs.statSync(metaPath()).ino).not.toBe(ino);
      expect(fs.readdirSync(path.join(sessionsDir, "s1")).sort()).toEqual([
        "meta.json",
        "scrollback.bin",
      ]);
      expect(readMeta().cwd).toBe("/new/path");

      writer.dispose();
    });

    it("does not lose endedAt to a cwd write still queued", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      void writer.updateCwd("/last");
      writer.end();
      writer.dispose();
      await writer.whenIdle();

      const meta = readMeta();
      expect(meta.cwd).toBe("/last");
      expect(meta.endedAt).toBeTruthy();
    });
  });

  describe("end", () => {
    it("writes endedAt to meta.json", () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.end();

      const meta = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, "s1", "meta.json"), "utf-8"),
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

      const content = fs.readFileSync(
        path.join(sessionsDir, "s1", "scrollback.bin"),
        "utf-8",
      );
      expect(content).toBe("unflushed data");
    });

    it("whenIdle covers the final writes queued behind a busy pane", async () => {
      const writer = new ScrollbackWriter("s1", sessionsDir);
      writer.init({ sessionId: "s1", cols: 80, rows: 24, cwd: "/tmp" });

      writer.append("in flight ");
      void writer.flush();
      writer.append("last");
      writer.end();
      writer.dispose();
      await writer.whenIdle();

      const dir = path.join(sessionsDir, "s1");
      expect(fs.readFileSync(path.join(dir, "scrollback.bin"), "utf-8")).toBe(
        "in flight last",
      );
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, "meta.json"), "utf-8"),
      ) as SessionMeta;
      expect(meta.endedAt).toBeTruthy();
    });
  });
});

describe("ScrollbackWriter static readers", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-scrollback-read-test-${crypto.randomUUID()}`,
    );
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

    fs.writeFileSync(
      path.join(sessionDir, "scrollback.bin"),
      scrollbackContent,
    );

    const fullMeta: SessionMeta = {
      sessionId,
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
      endedAt: null,
      ...meta,
    };
    fs.writeFileSync(
      path.join(sessionDir, "meta.json"),
      JSON.stringify(fullMeta),
    );
  }

  describe("readMeta", () => {
    it("reads meta.json for a session", () => {
      createPersistedSession("s1", "", {
        cwd: "/Users/test",
        cols: 120,
        rows: 40,
      });

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
      const content = ScrollbackWriter.readScrollback(
        "nonexistent",
        sessionsDir,
      );
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
      expect(() =>
        Buffer.from(restored, "utf-8").toString("utf-8"),
      ).not.toThrow();
      // Content should be <= limit
      expect(Buffer.from(restored, "utf-8").length).toBeLessThanOrEqual(
        COLD_RESTORE_MAX_BYTES,
      );
    });
  });

  describe("isUncleanShutdown", () => {
    it("returns true when endedAt is null", () => {
      createPersistedSession("s1", "data", { endedAt: null });
      expect(ScrollbackWriter.isUncleanShutdown("s1", sessionsDir)).toBe(true);
    });

    it("returns false when endedAt is set", () => {
      createPersistedSession("s1", "data", {
        endedAt: new Date().toISOString(),
      });
      expect(ScrollbackWriter.isUncleanShutdown("s1", sessionsDir)).toBe(false);
    });

    it("returns false for nonexistent session", () => {
      expect(
        ScrollbackWriter.isUncleanShutdown("nonexistent", sessionsDir),
      ).toBe(false);
    });
  });

  /**
   * `POST /sessions/read` passes an unresolved target through as a raw session
   * id, and ADR-161 puts that route on a listener reachable through a tunnel.
   * A session id therefore has to stay one directory name.
   */
  describe("session id containment", () => {
    it("accepts a real pane id", () => {
      expect(isSafeSessionId("pane-3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(
        true,
      );
    });

    it("rejects anything that is not a single path segment", () => {
      for (const bad of [
        "",
        ".",
        "..",
        "../secrets",
        "../../../../etc",
        "a/b",
        "a\\b",
        "/etc",
      ])
        expect(isSafeSessionId(bad), bad).toBe(false);
    });

    it("does not read a scrollback.bin outside the sessions directory", () => {
      const outside = path.join(tmpDir, "outside");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(
        path.join(outside, "scrollback.bin"),
        "SECRET-SCROLLBACK",
      );

      expect(ScrollbackWriter.readScrollback("../outside", sessionsDir)).toBe(
        "",
      );
    });

    it("does not read a meta.json outside the sessions directory", () => {
      const outside = path.join(tmpDir, "outside");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(
        path.join(outside, "meta.json"),
        JSON.stringify({ sessionId: "leaked" }),
      );

      expect(ScrollbackWriter.readMeta("../outside", sessionsDir)).toBeNull();
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
