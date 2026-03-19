import { describe, it, expect, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { MSG, encodeFrame, encodeJsonFrame } from "./pty-subprocess-ipc";

import "./xterm-env-polyfill";

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    return { stdin, stdout, on: vi.fn(), kill: vi.fn(), pid: 12345 };
  }),
}));

vi.mock("../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-test-zdotdir",
    historyFileFor: (id: string) => `/tmp/manor-test-sessions/${id}.history`,
    setupZdotdir: () => "/tmp/manor-test-zdotdir",
  },
}));

import { Session } from "./session";
import type { StreamEvent } from "./types";

function pushDataFrame(session: Session, data: string): void {
  const frame = encodeFrame(MSG.DATA, data);
  (session as any).decoder.push(frame);
}

function pushExitFrame(session: Session, exitCode: number): void {
  const frame = encodeJsonFrame(MSG.EXIT, { exitCode });
  (session as any).decoder.push(frame);
}

function mockSocket(): { socket: any; written: string[] } {
  const written: string[] = [];
  const socket = {
    write: (data: string) => { written.push(data); },
    on: vi.fn(),
    destroy: vi.fn(),
  };
  return { socket, written };
}

describe("Session", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session("test-session", "/tmp", 80, 24);
  });

  describe("snapshot content", () => {
    it("snapshot is empty before any data", async () => {
      const snapshot = await session.getSnapshot();
      expect(snapshot.screenAnsi).toBe("");
      expect(snapshot.cols).toBe(80);
      expect(snapshot.rows).toBe(24);
      expect(snapshot.cwd).toBe("/tmp");
    });

    it("snapshot contains data after writing to headless terminal", async () => {
      pushDataFrame(session, "hello world");
      const snapshot = await session.getSnapshot();
      expect(snapshot.screenAnsi).toContain("hello world");
    });

    it("snapshot preserves multiple lines of output", async () => {
      pushDataFrame(session, "line 1\r\n");
      pushDataFrame(session, "line 2\r\n");
      pushDataFrame(session, "line 3\r\n");
      const snapshot = await session.getSnapshot();
      expect(snapshot.screenAnsi).toContain("line 1");
      expect(snapshot.screenAnsi).toContain("line 2");
      expect(snapshot.screenAnsi).toContain("line 3");
    });

    it("snapshot preserves ANSI color codes", async () => {
      pushDataFrame(session, "\x1b[31mred text\x1b[0m");
      const snapshot = await session.getSnapshot();
      expect(snapshot.screenAnsi).toContain("red text");
    });

    it("snapshot survives large output (scrollback)", async () => {
      for (let i = 0; i < 50; i++) {
        pushDataFrame(session, `line ${i}\r\n`);
      }
      const snapshot = await session.getSnapshot();
      expect(snapshot.screenAnsi).toContain("line 0");
      expect(snapshot.screenAnsi).toContain("line 49");
    });

    it("snapshot reflects resize", async () => {
      session.resize(120, 40);
      const snapshot = await session.getSnapshot();
      expect(snapshot.cols).toBe(120);
      expect(snapshot.rows).toBe(40);
    });
  });

  describe("OSC 7 CWD tracking", () => {
    it("updates CWD from OSC 7 with BEL terminator", async () => {
      pushDataFrame(session, "\x1b]7;file://localhost/Users/test\x07");
      const snapshot = await session.getSnapshot();
      expect(snapshot.cwd).toBe("/Users/test");
    });

    it("updates CWD from OSC 7 with ST terminator", async () => {
      pushDataFrame(session, "\x1b]7;file://localhost/Users/test\x1b\\");
      const snapshot = await session.getSnapshot();
      expect(snapshot.cwd).toBe("/Users/test");
    });

    it("decodes percent-encoded paths", async () => {
      pushDataFrame(session, "\x1b]7;file://localhost/Users/test/my%20dir\x07");
      const snapshot = await session.getSnapshot();
      expect(snapshot.cwd).toBe("/Users/test/my dir");
    });

    it("handles OSC 7 without hostname", async () => {
      pushDataFrame(session, "\x1b]7;file:///Users/test\x07");
      const snapshot = await session.getSnapshot();
      expect(snapshot.cwd).toBe("/Users/test");
    });

    it("broadcasts CWD event to attached clients", () => {
      const { socket, written } = mockSocket();
      session.attachClient(socket);
      pushDataFrame(session, "\x1b]7;file://localhost/new/cwd\x07");

      const cwdEvents = written
        .map((line) => JSON.parse(line.trim()) as StreamEvent)
        .filter((e) => e.type === "cwd");
      expect(cwdEvents).toHaveLength(1);
      expect(cwdEvents[0].type === "cwd" && cwdEvents[0].cwd).toBe("/new/cwd");
    });

    it("CWD tracks across multiple updates", async () => {
      pushDataFrame(session, "\x1b]7;file://localhost/first\x07");
      expect((await session.getSnapshot()).cwd).toBe("/first");

      pushDataFrame(session, "\x1b]7;file://localhost/second\x07");
      expect((await session.getSnapshot()).cwd).toBe("/second");
    });

    it("ignores non-file:// OSC 7 payloads", async () => {
      pushDataFrame(session, "\x1b]7;http://example.com\x07");
      expect((await session.getSnapshot()).cwd).toBe("/tmp");
    });
  });

  describe("terminal mode tracking", () => {
    it("tracks bracketed paste mode", async () => {
      expect((await session.getSnapshot()).modes.bracketedPaste).toBe(false);
      pushDataFrame(session, "\x1b[?2004h");
      expect((await session.getSnapshot()).modes.bracketedPaste).toBe(true);
      pushDataFrame(session, "\x1b[?2004l");
      expect((await session.getSnapshot()).modes.bracketedPaste).toBe(false);
    });

    it("tracks application cursor mode", async () => {
      pushDataFrame(session, "\x1b[?1h");
      expect((await session.getSnapshot()).modes.applicationCursor).toBe(true);
      pushDataFrame(session, "\x1b[?1l");
      expect((await session.getSnapshot()).modes.applicationCursor).toBe(false);
    });

    it("tracks alt screen mode", async () => {
      pushDataFrame(session, "\x1b[?1049h");
      expect((await session.getSnapshot()).modes.altScreen).toBe(true);
      pushDataFrame(session, "\x1b[?1049l");
      expect((await session.getSnapshot()).modes.altScreen).toBe(false);
    });

    it("tracks mouse tracking mode", async () => {
      pushDataFrame(session, "\x1b[?1000h");
      expect((await session.getSnapshot()).modes.mouseTracking).toBe(true);
      pushDataFrame(session, "\x1b[?1000l");
      expect((await session.getSnapshot()).modes.mouseTracking).toBe(false);
    });

    it("tracks reverse wraparound mode", async () => {
      pushDataFrame(session, "\x1b[?45h");
      expect((await session.getSnapshot()).modes.reverseWraparound).toBe(true);
      pushDataFrame(session, "\x1b[?45l");
      expect((await session.getSnapshot()).modes.reverseWraparound).toBe(false);
    });

    it("mode changes included in snapshot", async () => {
      pushDataFrame(session, "\x1b[?2004h\x1b[?1049h");
      const snapshot = await session.getSnapshot();
      expect(snapshot.modes.bracketedPaste).toBe(true);
      expect(snapshot.modes.altScreen).toBe(true);
      expect(snapshot.modes.applicationCursor).toBe(false);
    });
  });

  describe("client broadcast", () => {
    it("broadcasts data events to attached clients", () => {
      const { socket, written } = mockSocket();
      session.attachClient(socket);
      pushDataFrame(session, "hello");

      const dataEvents = written
        .map((line) => JSON.parse(line.trim()) as StreamEvent)
        .filter((e) => e.type === "data");
      expect(dataEvents).toHaveLength(1);
      expect(dataEvents[0].type === "data" && dataEvents[0].data).toBe("hello");
      expect(dataEvents[0].sessionId).toBe("test-session");
    });

    it("broadcasts to multiple attached clients", () => {
      const client1 = mockSocket();
      const client2 = mockSocket();
      session.attachClient(client1.socket);
      session.attachClient(client2.socket);
      pushDataFrame(session, "shared");

      expect(client1.written.some((l) => JSON.parse(l.trim()).data === "shared")).toBe(true);
      expect(client2.written.some((l) => JSON.parse(l.trim()).data === "shared")).toBe(true);
    });

    it("detached client stops receiving events", () => {
      const { socket, written } = mockSocket();
      session.attachClient(socket);
      pushDataFrame(session, "before");
      session.detachClient(socket);
      pushDataFrame(session, "after");

      const dataEvents = written
        .map((line) => JSON.parse(line.trim()) as StreamEvent)
        .filter((e) => e.type === "data");
      expect(dataEvents).toHaveLength(1);
      expect(dataEvents[0].type === "data" && dataEvents[0].data).toBe("before");
    });

    it("broadcasts exit event when PTY exits", () => {
      const { socket, written } = mockSocket();
      session.attachClient(socket);
      pushExitFrame(session, 0);

      const exitEvents = written
        .map((line) => JSON.parse(line.trim()) as StreamEvent)
        .filter((e) => e.type === "exit");
      expect(exitEvents).toHaveLength(1);
      expect(exitEvents[0].type === "exit" && exitEvents[0].exitCode).toBe(0);
    });

    it("marks session as not alive after exit", () => {
      expect(session.alive).toBe(true);
      pushExitFrame(session, 1);
      expect(session.alive).toBe(false);
    });
  });

  describe("session info", () => {
    it("returns correct info", () => {
      const info = session.info;
      expect(info.sessionId).toBe("test-session");
      expect(info.cwd).toBe("/tmp");
      expect(info.cols).toBe(80);
      expect(info.rows).toBe(24);
      expect(info.alive).toBe(true);
    });

    it("info reflects resize", () => {
      session.resize(120, 40);
      expect(session.info.cols).toBe(120);
      expect(session.info.rows).toBe(40);
    });
  });
});
