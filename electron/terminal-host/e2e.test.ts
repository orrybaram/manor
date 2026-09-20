/**
 * End-to-end tests for the terminal daemon architecture.
 *
 * These tests exercise the full pipeline: daemon socket server → session →
 * scrollback persistence → warm/cold restore.
 *
 * Uses real temp directories for all I/O (no filesystem mocks).
 * PTY subprocesses are still mocked since we don't need real shells.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import "./xterm-env-polyfill";

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    return { stdin, stdout, on: vi.fn(), kill: vi.fn(), pid: 77777 };
  }),
  spawn: vi.fn(),
}));

vi.mock("../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-e2e-zdotdir",
    setupZdotdir: () => "/tmp/manor-e2e-zdotdir",
  },
}));

import { ScrollbackWriter, type SessionMeta } from "./scrollback";
import {
  connectRaw,
  delay,
  E2EDaemon,
  feedSessionData,
  flushScrollback,
  makeTmpDir,
} from "./daemon-harness";

// ── Helpers ──


// ── Tests ──

describe("E2E: scrollback persistence through daemon", () => {
  let tmpDir: string;
  let daemon: E2EDaemon;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    daemon = new E2EDaemon(tmpDir);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creating a session via socket writes meta.json and scrollback.bin to disk", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp/test",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    // Session dir should exist
    const sessionDir = path.join(daemon.sessionsDir, "s1");
    expect(fs.existsSync(sessionDir)).toBe(true);

    // meta.json should have correct content
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    ) as SessionMeta;
    expect(meta.sessionId).toBe("s1");
    expect(meta.cwd).toBe("/tmp/test");
    expect(meta.cols).toBe(80);
    expect(meta.rows).toBe(24);
    expect(meta.endedAt).toBeNull();

    // scrollback.bin should exist (empty initially)
    expect(fs.existsSync(path.join(sessionDir, "scrollback.bin"))).toBe(true);

    client.close();
  });

  it("PTY output is written to scrollback.bin on disk", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    // Feed data into the session
    feedSessionData(daemon.getHost(), "s1", "hello from the PTY\r\n");
    feedSessionData(daemon.getHost(), "s1", "second line of output\r\n");

    // Force flush (normally buffered for 2s)
    flushScrollback(daemon.getHost(), "s1");

    const scrollback = fs.readFileSync(
      path.join(daemon.sessionsDir, "s1", "scrollback.bin"),
      "utf-8",
    );
    expect(scrollback).toContain("hello from the PTY");
    expect(scrollback).toContain("second line of output");

    client.close();
  });

  it("OSC 7 CWD change updates meta.json on disk", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/start",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    feedSessionData(
      daemon.getHost(),
      "s1",
      "\x1b]7;file://localhost/Users/new/dir\x07",
    );
    flushScrollback(daemon.getHost(), "s1");

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(daemon.sessionsDir, "s1", "meta.json"),
        "utf-8",
      ),
    ) as SessionMeta;
    expect(meta.cwd).toBe("/Users/new/dir");

    client.close();
  });

  it("killing a session marks endedAt in meta.json", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    // Dispose the session (simulates clean shutdown)
    daemon.getHost().disposeSession("s1");

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(daemon.sessionsDir, "s1", "meta.json"),
        "utf-8",
      ),
    ) as SessionMeta;
    expect(meta.endedAt).not.toBeNull();

    client.close();
  });

  it("unclean shutdown detection: meta.json has no endedAt", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    // Session is alive — endedAt should be null
    expect(ScrollbackWriter.isUncleanShutdown("s1", daemon.sessionsDir)).toBe(
      true,
    );

    // After clean end
    daemon.getHost().disposeSession("s1");
    expect(ScrollbackWriter.isUncleanShutdown("s1", daemon.sessionsDir)).toBe(
      false,
    );

    client.close();
  });
});

describe("E2E: warm restore through daemon sockets", () => {
  let tmpDir: string;
  let daemon: E2EDaemon;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    daemon = new E2EDaemon(tmpDir);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("client1 writes data, disconnects; client2 attaches and gets snapshot with data + scrollback on disk", async () => {
    // Client 1: create session, write data
    const c1 = await connectRaw(daemon.socketPath);
    c1.send({ type: "auth", token: daemon.authToken });
    await c1.readLine();

    c1.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await c1.readLine();

    feedSessionData(daemon.getHost(), "s1", "important output");
    flushScrollback(daemon.getHost(), "s1");

    // Disconnect client 1
    c1.close();
    await delay(50);

    // Verify scrollback on disk
    const scrollback = fs.readFileSync(
      path.join(daemon.sessionsDir, "s1", "scrollback.bin"),
      "utf-8",
    );
    expect(scrollback).toContain("important output");

    // Client 2: attach and get snapshot
    const c2 = await connectRaw(daemon.socketPath);
    c2.send({ type: "auth", token: daemon.authToken });
    await c2.readLine();

    c2.send({ type: "attach", sessionId: "s1" });
    const resp = await c2.readLine();

    expect(resp.type).toBe("attached");
    expect(resp.snapshot.screenAnsi).toContain("important output");

    c2.close();
  });

  it("warm restore preserves CWD, modes, and continues streaming", async () => {
    const c1 = await connectRaw(daemon.socketPath);
    c1.send({ type: "auth", token: daemon.authToken });
    await c1.readLine();

    c1.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await c1.readLine();

    feedSessionData(
      daemon.getHost(),
      "s1",
      "\x1b]7;file://localhost/restored/cwd\x07",
    );
    feedSessionData(daemon.getHost(), "s1", "\x1b[?2004h"); // bracketed paste on

    c1.close();
    await delay(50);

    // Client 2 attaches
    const c2 = await connectRaw(daemon.socketPath);
    c2.send({ type: "auth", token: daemon.authToken });
    await c2.readLine();

    c2.send({ type: "getSnapshot", sessionId: "s1" });
    const snap = await c2.readLine();

    expect(snap.snapshot.cwd).toBe("/restored/cwd");
    expect(snap.snapshot.modes.bracketedPaste).toBe(true);

    // Subscribe to stream and verify new data flows
    const stream = await connectRaw(daemon.socketPath);
    stream.send({ connectionType: "stream", token: daemon.authToken });
    stream.send({ type: "subscribe", sessionId: "s1" });
    await delay(50);

    feedSessionData(daemon.getHost(), "s1", "new data after reattach");

    const event = await stream.readLine();
    expect(event.type).toBe("data");
    expect(event.data).toBe("new data after reattach");

    c2.close();
    stream.close();
  });
});

describe("E2E: cold restore from scrollback on disk", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scrollback written by daemon1 is readable after daemon1 dies and daemon2 starts", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");

    // Daemon 1: create session, write data, stop abruptly (no clean end)
    const daemon1 = new E2EDaemon(tmpDir);
    await daemon1.start();

    const c1 = await connectRaw(daemon1.socketPath);
    c1.send({ type: "auth", token: daemon1.authToken });
    await c1.readLine();

    c1.send({
      type: "create",
      sessionId: "s1",
      cwd: "/project/code",
      cols: 120,
      rows: 40,
    });
    await c1.readLine();

    feedSessionData(daemon1.getHost(), "s1", "$ git status\r\n");
    feedSessionData(daemon1.getHost(), "s1", "On branch main\r\n");
    feedSessionData(
      daemon1.getHost(),
      "s1",
      "nothing to commit, working tree clean\r\n",
    );
    flushScrollback(daemon1.getHost(), "s1");

    c1.close();
    // Stop daemon1 WITHOUT clean session end (simulate crash)
    await daemon1.crash();

    // Verify: meta.json exists, endedAt is null (unclean), scrollback has content
    expect(ScrollbackWriter.isUncleanShutdown("s1", sessionsDir)).toBe(true);

    const meta = ScrollbackWriter.readMeta("s1", sessionsDir);
    expect(meta).not.toBeNull();
    expect(meta!.cwd).toBe("/project/code");
    expect(meta!.cols).toBe(120);
    expect(meta!.rows).toBe(40);

    const scrollback = ScrollbackWriter.readScrollback("s1", sessionsDir);
    expect(scrollback).toContain("git status");
    expect(scrollback).toContain("nothing to commit");

    // Daemon 2: session "s1" is gone from memory, but scrollback is on disk
    const daemon2 = new E2EDaemon(tmpDir);
    await daemon2.start();

    const c2 = await connectRaw(daemon2.socketPath);
    c2.send({ type: "auth", token: daemon2.authToken });
    await c2.readLine();

    // Session s1 doesn't exist in daemon2
    c2.send({ type: "attach", sessionId: "s1" });
    const attachResp = await c2.readLine();
    expect(attachResp.type).toBe("error"); // not found — daemon2 never had it

    // But we can read scrollback from disk for cold restore
    const coldScrollback = ScrollbackWriter.readScrollback("s1", sessionsDir);
    expect(coldScrollback).toContain("git status");
    expect(coldScrollback).toContain("nothing to commit");

    // Create a new session in the same CWD for the user
    c2.send({
      type: "create",
      sessionId: "s1-restored",
      cwd: meta!.cwd!,
      cols: meta!.cols,
      rows: meta!.rows,
    });
    const createResp = await c2.readLine();
    expect(createResp.type).toBe("created");
    expect(createResp.session.cwd).toBe("/project/code");

    c2.close();
    await daemon2.stop();
  });

  it("listPersistedSessions returns sessions from disk after daemon restart", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");

    const daemon1 = new E2EDaemon(tmpDir);
    await daemon1.start();

    const c = await connectRaw(daemon1.socketPath);
    c.send({ type: "auth", token: daemon1.authToken });
    await c.readLine();

    // Create 3 sessions
    for (const id of ["s1", "s2", "s3"]) {
      c.send({
        type: "create",
        sessionId: id,
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      });
      await c.readLine();
      feedSessionData(daemon1.getHost(), id, `output for ${id}`);
      flushScrollback(daemon1.getHost(), id);
    }

    c.close();
    await daemon1.stop();

    // After daemon dies, we can list persisted sessions from disk
    const persisted = ScrollbackWriter.listPersistedSessions(sessionsDir);
    expect(persisted.sort()).toEqual(["s1", "s2", "s3"]);
  });
});

describe("E2E: clear-scrollback escape sequence", () => {
  let tmpDir: string;
  let daemon: E2EDaemon;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    daemon = new E2EDaemon(tmpDir);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("\\e[3J truncates scrollback.bin on disk", async () => {
    const c = await connectRaw(daemon.socketPath);
    c.send({ type: "auth", token: daemon.authToken });
    await c.readLine();

    c.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await c.readLine();

    feedSessionData(daemon.getHost(), "s1", "old stuff\r\n");
    flushScrollback(daemon.getHost(), "s1");

    const before = fs.readFileSync(
      path.join(daemon.sessionsDir, "s1", "scrollback.bin"),
      "utf-8",
    );
    expect(before).toContain("old stuff");

    // Send clear-scrollback
    feedSessionData(daemon.getHost(), "s1", "\x1b[3J");
    feedSessionData(daemon.getHost(), "s1", "fresh start\r\n");
    flushScrollback(daemon.getHost(), "s1");

    const after = fs.readFileSync(
      path.join(daemon.sessionsDir, "s1", "scrollback.bin"),
      "utf-8",
    );
    expect(after).not.toContain("old stuff");
    expect(after).toContain("fresh start");

    c.close();
  });
});
