import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type { Duplex } from "node:stream";
import * as net from "node:net";
import * as fs from "node:fs";
import { E2EDaemon, makeTmpDir } from "../daemon-harness";
import { runRemoteBridge } from "../bridge";
import type { HostTransport } from "../transport";

/** A `HostTransport` that hands out sockets to an already-running `E2EDaemon`
 *  instead of spawning anything, so the bridge is exercised against a real
 *  temp-dir daemon without touching the real `~/.manor/daemon`. */
class FakeTransport implements HostTransport {
  constructor(private readonly daemon: E2EDaemon) {}

  async ensureRunning(): Promise<void> {
    // The daemon is already running — nothing to spawn.
  }

  async restart(): Promise<void> {
    throw new Error("not exercised in this test");
  }

  connectControl(): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.daemon.socketPath, () =>
        resolve(socket),
      );
      socket.on("error", reject);
    });
  }

  connectStream(): Promise<Duplex> {
    return this.connectControl();
  }

  async authToken(): Promise<string> {
    return this.daemon.authToken;
  }

  async dispose(): Promise<void> {
    // Nothing held.
  }
}

/** Buffers NDJSON lines written to `stream` and doles them out on demand. */
function readLines(stream: PassThrough): { next(): Promise<string> } {
  let buffer = "";
  const queue: string[] = [];
  let waiting: ((line: string) => void) | null = null;

  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(line);
      } else {
        queue.push(line);
      }
    }
  });

  return {
    next(): Promise<string> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
  };
}

describe("runRemoteBridge", () => {
  let tmpDir: string;
  let daemon: E2EDaemon;
  const originalVersion = process.env.MANOR_VERSION;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    daemon = new E2EDaemon(tmpDir);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.MANOR_VERSION = originalVersion;
  });

  it("writes a bridgeHello preamble, then pumps a ping/pong round trip", async () => {
    process.env.MANOR_VERSION = "1.2.3-test";

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines = readLines(stdout);

    const bridgeDone = runRemoteBridge(
      { stdin, stdout, stderr },
      new FakeTransport(daemon),
    );

    const hello = JSON.parse(await lines.next());
    expect(hello).toEqual({
      type: "bridgeHello",
      token: daemon.authToken,
      daemonVersion: "1.2.3-test",
    });

    stdin.write(
      JSON.stringify({ type: "auth", token: daemon.authToken }) + "\n",
    );
    expect(JSON.parse(await lines.next())).toEqual({ type: "authOk" });

    stdin.write(JSON.stringify({ type: "ping" }) + "\n");
    expect(JSON.parse(await lines.next())).toEqual({ type: "pong" });

    stdin.end();
    expect(await bridgeDone).toBe(0);
  });

  it("reports a null daemonVersion when MANOR_VERSION is unset", async () => {
    delete process.env.MANOR_VERSION;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines = readLines(stdout);

    const bridgeDone = runRemoteBridge(
      { stdin, stdout, stderr },
      new FakeTransport(daemon),
    );

    const hello = JSON.parse(await lines.next());
    expect(hello.daemonVersion).toBeNull();

    stdin.end();
    await bridgeDone;
  });

  it("ends the pump once stdin reaches EOF", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines = readLines(stdout);

    const bridgeDone = runRemoteBridge(
      { stdin, stdout, stderr },
      new FakeTransport(daemon),
    );
    await lines.next(); // bridgeHello

    stdin.end();
    expect(await bridgeDone).toBe(0);
  });
});
