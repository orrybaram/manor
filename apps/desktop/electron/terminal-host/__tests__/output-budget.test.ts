/**
 * Byte budgets for terminal output on the daemon side (#733, Stage 0 of the
 * output-channel plan).
 *
 * These pin what a flood costs *today*, in bytes, so each later perf stage
 * turns a test from red to green rather than arguing from a benchmark. The
 * numbers are counted, never timed: an in-process daemon with a fake pty
 * helper, `MSG.DATA` frames injected straight into the session, and the
 * bytes read off real Unix sockets.
 *
 * Each ceiling is today's measured value plus about 10%. A ceiling going red
 * means the output path got more expensive per byte; a target (`it.fails`)
 * going "red" means a stage landed and the target should become a plain `it`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import { PassThrough } from "node:stream";

import "../xterm-env-polyfill";

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    return { stdin, stdout, on: vi.fn(), kill: vi.fn(), pid: 77777 };
  }),
  spawn: vi.fn(),
}));

vi.mock("../../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-budget-zdotdir",
    setupZdotdir: () => "/tmp/manor-budget-zdotdir",
  },
}));

import {
  connectRaw,
  E2EDaemon,
  feedSessionData,
  makeTmpDir,
} from "../daemon-harness";
import type { Session } from "../session";
import type { TerminalHost } from "../terminal-host";

/**
 * The overload benchmark's flood line (`tests/e2e/overload-perf.spec.ts`):
 * 108 bytes, six escapes and one `✓`, which makes every chunk a two-byte JS
 * string — as any agent TUI's output is.
 */
const FLOOD_LINE =
  "\x1b[32m✓\x1b[0m \x1b[1mtool_result\x1b[0m src/components/SomethingLong.tsx:123 \x1b[33mwarning\x1b[0m lorem ipsum zqflood\r\n";
/** As many flood lines as fit in the helper's 64 KiB batch: 65,448 bytes. */
const LINES_PER_CHUNK = Math.floor((64 * 1024) / Buffer.byteLength(FLOOD_LINE));
const FLOOD_CHUNK = FLOOD_LINE.repeat(LINES_PER_CHUNK);
const CHUNK_BYTES = Buffer.byteLength(FLOOD_CHUNK);
/** A 1 MiB flood, as the helper would frame it: sixteen full batches. */
const FLOOD_CHUNKS = 16;
const FLOOD_BYTES = CHUNK_BYTES * FLOOD_CHUNKS;

/**
 * Wait for a condition by yielding to the event loop, not to the clock: each
 * turn lets socket I/O and the headless parser run. The cap is a hang guard,
 * not a timeout anyone tunes.
 */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 200_000; turn++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`never happened: ${what}`);
}

function attachedSockets(host: TerminalHost, sessionId: string): number {
  const session = (
    host as unknown as { sessions: Map<string, Session> }
  ).sessions.get(sessionId);
  const clients = (session as unknown as { attachedClients: Map<unknown, unknown> })
    .attachedClients;
  return clients.size;
}

describe("terminal output byte budgets (daemon)", () => {
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

  async function createSession(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<Awaited<ReturnType<typeof connectRaw>>> {
    const control = await connectRaw(daemon.socketPath);
    control.send({ type: "auth", token: daemon.authToken });
    await control.readLine();
    control.send({ type: "create", sessionId, cwd: "/tmp", cols, rows });
    await control.readLine();
    return control;
  }

  /**
   * Flood a session through a raw client attached as a stream, the way main's
   * one stream socket is, and count everything it reads.
   */
  async function floodThroughStream(): Promise<{
    socketBytes: number;
    dataFrames: number;
  }> {
    const control = await createSession("flood", 120, 40);
    const host = daemon.getHost();

    const socket = net.createConnection(daemon.socketPath);
    await new Promise((r) => socket.once("connect", r));
    socket.write(
      JSON.stringify({ connectionType: "stream", token: daemon.authToken }) + "\n",
    );
    // Reads today's NDJSON. Stage 1 (#298) changes the stream framing, and
    // this reader with it. Done is the last chunk's seq arriving, not a byte
    // count, so a fatter encoding cannot end the read early.
    let dataFrames = 0;
    let lastSeq = 0;
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type !== "data") continue;
        dataFrames++;
        lastSeq = Math.max(lastSeq, event.seq);
      }
    });
    socket.write(JSON.stringify({ type: "subscribe", sessionId: "flood" }) + "\n");
    await until(() => attachedSockets(host, "flood") === 1, "stream subscribed");

    for (let i = 0; i < FLOOD_CHUNKS; i++) {
      feedSessionData(host, "flood", FLOOD_CHUNK);
    }
    // The session numbers its output from 1, one seq per helper frame.
    await until(() => lastSeq >= FLOOD_CHUNKS, "the whole flood read");

    const socketBytes = socket.bytesRead;
    socket.destroy();
    control.close();
    return { socketBytes, dataFrames };
  }

  // Observed: 1,358,311 stream-socket bytes for 1,047,168 payload bytes, 1.297×
  // (each 65,448 B chunk becomes an 84,935 B NDJSON line: JSON escapes for the
  // six ESCs per line, plus the envelope). The value is identical run to run,
  // so the ceiling is a tight 1.35× (~4%): double-encoding the payload gives
  // 1.371× and must go red here.
  // Over it means the daemon → main hop encodes output less efficiently than
  // NDJSON does today: more escaping, a bigger envelope, or a frame sent twice.
  it("sends at most 1.35 stream-socket bytes per payload byte in a 1 MiB flood", async () => {
    const { socketBytes } = await floodThroughStream();
    const ratio = socketBytes / FLOOD_BYTES;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThanOrEqual(1.35);
  });

  // Target for Stage 1, binary data frames on the stream socket (#298): a
  // `[kind][len][body]` frame carries the payload bytes as they are, so the
  // overhead is a few dozen bytes per 64 KiB, ≤ 1.01×. Fails today at 1.30×;
  // when Stage 1 lands this passes and becomes a plain `it`.
  it.fails("target: at most 1.01 stream-socket bytes per payload byte after binary framing (#298)", async () => {
    const { socketBytes } = await floodThroughStream();
    expect(socketBytes / FLOOD_BYTES).toBeLessThanOrEqual(1.01);
  });

  // Observed: 16 data frames for the 1 MiB flood, one per helper batch —
  // 16 frames per MiB, each ~64 KiB. Pinned exactly, not with headroom: the
  // daemon neither splits nor duplicates a helper frame today. More frames
  // means each batch got smaller or was sent twice (more per-frame cost on
  // every hop after this one); fewer means frames are being merged or lost.
  // The helper's own 4 ms / 64 KiB batching runs on a timer in another
  // process and is not reached here; this pins the daemon's half. No stage
  // of the plan aims to change batching, so this has no `it.fails` target.
  it("sends one data frame per 64 KiB helper batch: 16 per MiB", async () => {
    const { dataFrames } = await floodThroughStream();
    expect(dataFrames).toBe(16);
  });

  // Observed after a 10k-line flood at 120×40 (17 chunks, 10,302 lines, so the
  // 10,000-line scrollback plus the screen is full): `screenAnsi` is 1,084,218
  // UTF-8 bytes and the control reply line 1,405,723 bytes (the snapshot
  // JSON-escaped, plus the envelope). Ceilings: 1.15 MB for the snapshot
  // (~6% headroom, the figure the plan pins) and 1.55 MB for the reply (~10%).
  // Over them means attach / catch-up costs more after a flood: more
  // scrollback kept, a fatter serialisation, or the snapshot sent twice. If
  // Stage 5 cuts scrollback, tighten these (≤ 600 KB was the estimate).
  it("keeps the post-flood snapshot under 1.15 MB, and its reply under 1.55 MB", async () => {
    const control = await createSession("snap", 120, 40);
    const host = daemon.getHost();
    for (let i = 0; i < 17; i++) feedSessionData(host, "snap", FLOOD_CHUNK);

    // Count the reply's bytes off the socket, as main reads them.
    const before = control.socket.bytesRead;
    control.send({ type: "getSnapshot", sessionId: "snap" });
    const reply = await control.readLine();
    const replyBytes = control.socket.bytesRead - before;
    const snapshotBytes = Buffer.byteLength(reply.snapshot.screenAnsi, "utf-8");

    expect(reply.type).toBe("snapshot");
    expect(snapshotBytes).toBeGreaterThan(1_000_000);
    expect(snapshotBytes).toBeLessThanOrEqual(1_150_000);
    expect(replyBytes).toBeLessThanOrEqual(1_550_000);
    control.close();
  });
});
