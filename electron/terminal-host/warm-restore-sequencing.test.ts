/**
 * ADR-159 — a client that reattaches to a live session must end up showing
 * exactly what the daemon shows: nothing missing, nothing applied twice.
 *
 * The warm-restore handshake is three separate round trips (resize, subscribe,
 * snapshot) and the PTY keeps producing output across all of them, so every
 * ordering leaves a window. These tests render snapshot-plus-stream into a
 * fresh terminal the way the renderer does, and compare screens.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
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
    zdotdirPath: () => "/tmp/manor-seq-zdotdir",
    setupZdotdir: () => "/tmp/manor-seq-zdotdir",
  },
}));

import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  connectRaw,
  delay,
  E2EDaemon,
  feedSessionData,
  makeTmpDir,
} from "./daemon-harness";
import type { TerminalSnapshot } from "./types";

describe("warm restore delivers output exactly once", () => {
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

  /** Write to a headless terminal and wait for the parser to drain. */
  function writeAsync(term: HeadlessTerminal, data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, resolve));
  }

  /**
   * Replay a restore into a fresh terminal exactly as the renderer does:
   * write the snapshot, then the streamed chunks, skipping any chunk the
   * snapshot already accounts for.
   */
  async function replayRestore(
    snapshot: TerminalSnapshot,
    events: Array<{ data: string; seq?: number }>,
  ): Promise<string> {
    const term = new HeadlessTerminal({
      cols: snapshot.cols,
      rows: snapshot.rows,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);

    await writeAsync(term, snapshot.screenAnsi);
    const snapshotSeq = (snapshot as { seq?: number }).seq;
    for (const event of events) {
      const covered =
        snapshotSeq !== undefined &&
        event.seq !== undefined &&
        event.seq <= snapshotSeq;
      if (covered) continue;
      await writeAsync(term, event.data);
    }
    return serializer.serialize();
  }

  /** Connect a stream socket and collect the data events it receives. */
  async function streamClient(): Promise<{
    subscribe: (sessionId: string) => void;
    events: Array<{ data: string; seq?: number }>;
    close: () => void;
  }> {
    const socket = net.createConnection(daemon.socketPath);
    await new Promise((r) => socket.once("connect", r));
    socket.write(
      JSON.stringify({ connectionType: "stream", token: daemon.authToken }) +
        "\n",
    );
    const events: Array<{ data: string; seq?: number }> = [];
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.type === "data") {
          events.push({ data: parsed.data, seq: parsed.seq });
        }
      }
    });
    return {
      subscribe: (sessionId: string) =>
        socket.write(JSON.stringify({ type: "subscribe", sessionId }) + "\n"),
      events,
      close: () => socket.destroy(),
    };
  }

  async function createSession(sessionId: string): Promise<
    Awaited<ReturnType<typeof connectRaw>>
  > {
    const control = await connectRaw(daemon.socketPath);
    control.send({ type: "auth", token: daemon.authToken });
    await control.readLine();
    control.send({
      type: "create",
      sessionId,
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await control.readLine();
    return control;
  }

  it("loses nothing emitted while the handshake is in flight", async () => {
    const control = await createSession("gap");
    const host = daemon.getHost();
    feedSessionData(host, "gap", "BANNER LINE\r\n");
    await delay(20);

    // The handshake the client performs, with the PTY producing output
    // throughout: resize, subscribe, snapshot.
    control.send({ type: "resize", sessionId: "gap", cols: 100, rows: 30 });
    await control.readLine();

    feedSessionData(host, "gap", "AFTER RESIZE\r\n");
    await delay(20);

    const stream = await streamClient();
    stream.subscribe("gap");
    await delay(20);

    feedSessionData(host, "gap", "MIDDLE LINE\r\n");
    await delay(20);

    control.send({ type: "getSnapshot", sessionId: "gap" });
    const snapResp = await control.readLine();
    const snapshot = snapResp.snapshot as TerminalSnapshot;

    feedSessionData(host, "gap", "AFTER LINE\r\n");
    await delay(50);

    const restored = await replayRestore(snapshot, stream.events);
    const truth = (await host.getSnapshot("gap"))!.screenAnsi;
    expect(restored).toBe(truth);

    stream.close();
    control.close();
  });

  it("applies output delivered both in the snapshot and on the stream only once", async () => {
    const control = await createSession("dup");
    const host = daemon.getHost();
    feedSessionData(host, "dup", "BANNER LINE\r\n");
    await delay(20);

    // Subscribing first closes the loss window, at the cost of delivering
    // output the snapshot will also contain — the case seq numbers resolve.
    const stream = await streamClient();
    stream.subscribe("dup");
    await delay(20);

    feedSessionData(host, "dup", "REPAINT LINE\r\n");
    await delay(20);

    control.send({ type: "getSnapshot", sessionId: "dup" });
    const snapResp = await control.readLine();
    const snapshot = snapResp.snapshot as TerminalSnapshot;

    feedSessionData(host, "dup", "LATER LINE\r\n");
    await delay(50);

    const restored = await replayRestore(snapshot, stream.events);
    const truth = (await host.getSnapshot("dup"))!.screenAnsi;
    expect(restored).toBe(truth);

    stream.close();
    control.close();
  });
});
