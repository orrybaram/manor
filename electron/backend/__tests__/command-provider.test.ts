import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import {
  CommandHostProvider,
  remotePortPipeCommand,
} from "../providers/command-provider";
import type { BridgeChildProcess } from "../../terminal-host/bridge-spawner";

/**
 * A stand-in for an exec child running `manor-host port-pipe`: whatever
 * reaches its stdin comes back on its stdout, as if the box's port echoed.
 */
class FakePipeChild extends EventEmitter implements BridgeChildProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  written = "";

  constructor(
    readonly command: string,
    readonly args: string[],
  ) {
    super();
    this.stdin.on("data", (c: Buffer) => (this.written += c.toString("utf-8")));
    this.stdin.pipe(this.stdout);
  }

  kill(): boolean {
    if (!this.killed) {
      this.killed = true;
      setImmediate(() => this.exit(null));
    }
    return true;
  }

  /** Exit on its own, the way port-pipe does when the box's port closes. */
  exit(code: number | null): void {
    this.stdout.end();
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

function makeProvider(argv = ["kubectl", "exec", "-i", "pod", "--"]) {
  const children: FakePipeChild[] = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    const child = new FakePipeChild(command, args);
    children.push(child);
    return child;
  });
  const ensureRemoteHost = vi.fn(async () => {});
  const provider = new CommandHostProvider(argv, { spawn, ensureRemoteHost });
  return { provider, spawn, children, ensureRemoteHost };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

function collect(socket: net.Socket): () => string {
  let got = "";
  socket.on("data", (c: Buffer) => (got += c.toString("utf-8")));
  return () => got;
}

function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });
}

const providers: CommandHostProvider[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(providers.splice(0).map((p) => p.dispose()));
});

function tracked(...made: ReturnType<typeof makeProvider>[]) {
  for (const m of made) providers.push(m.provider);
}

async function open(port: number): Promise<net.Socket> {
  const socket = await connect(port);
  sockets.push(socket);
  return socket;
}

describe("remotePortPipeCommand", () => {
  it("runs the installed manor-host through sh, so $HOME expands", () => {
    expect(remotePortPipeCommand(5173, "127.0.0.1")).toBe(
      'exec "$HOME/.manor/bin/manor-host" port-pipe 5173',
    );
    expect(remotePortPipeCommand(8080, "::1")).toBe(
      'exec "$HOME/.manor/bin/manor-host" port-pipe 8080 --host ::1',
    );
    expect(() => remotePortPipeCommand(0, "127.0.0.1")).toThrow(/Invalid remote port/);
  });
});

describe("CommandHostProvider", () => {
  it("has the no-op lifecycle", async () => {
    const m = makeProvider();
    tracked(m);
    expect(m.provider.capabilities).toEqual({ canStop: false, canDestroy: false, autoSleep: false });
    await m.provider.ensureUp();
    expect(await m.provider.status()).toEqual({ state: "up" });
    expect(m.spawn).not.toHaveBeenCalled();
  });

  it("reports unreachable after a failed bootstrap, and up after the next good one", async () => {
    const m = makeProvider();
    tracked(m);
    m.ensureRemoteHost.mockRejectedValueOnce(new Error("no node on the box"));
    await expect(m.provider.transport().ensureRunning()).rejects.toThrow(/no node/);
    expect(await m.provider.status()).toEqual({
      state: "unreachable",
      detail: "no node on the box",
    });
    await m.provider.transport().ensureRunning();
    expect(await m.provider.status()).toEqual({ state: "up" });
  });

  it("delegates the server channels to the transport", async () => {
    const m = makeProvider();
    tracked(m);
    const transport = m.provider.transport();
    const owner = vi.spyOn(transport, "openServerBridge").mockResolvedValue(new PassThrough());
    const viewer = vi.spyOn(transport, "openViewerBridge").mockResolvedValue(new PassThrough());
    await m.provider.openServerChannel();
    await m.provider.openViewerChannel();
    expect(owner).toHaveBeenCalledOnce();
    expect(viewer).toHaveBeenCalledOnce();
  });

  it("forwardPort spawns one port-pipe child per accepted connection", async () => {
    const m = makeProvider();
    tracked(m);
    const forward = await m.provider.forwardPort(5173);
    expect(m.spawn).not.toHaveBeenCalled();

    const a = await open(forward.localPort);
    const b = await open(forward.localPort);
    await vi.waitFor(() => expect(m.children).toHaveLength(2));
    for (const child of m.children) {
      expect([child.command, ...child.args]).toEqual([
        "kubectl",
        "exec",
        "-i",
        "pod",
        "--",
        "sh",
        "-c",
        'exec "$HOME/.manor/bin/manor-host" port-pipe 5173',
      ]);
    }

    const gotA = collect(a);
    const gotB = collect(b);
    a.write("to a\n");
    b.write("to b\n");
    await vi.waitFor(() => expect(gotA()).toBe("to a\n"));
    await vi.waitFor(() => expect(gotB()).toBe("to b\n"));
  });

  it("asks port-pipe for ::1, and nothing past loopback", async () => {
    const m = makeProvider();
    tracked(m);
    const v6 = await m.provider.forwardPort(8080, { remoteHost: "::1" });
    const other = await m.provider.forwardPort(8081, { remoteHost: "10.0.0.5" });
    await open(v6.localPort);
    await open(other.localPort);
    await vi.waitFor(() => expect(m.children).toHaveLength(2));
    const snippets = m.children.map((c) => c.args[c.args.length - 1]).sort();
    expect(snippets).toEqual([
      'exec "$HOME/.manor/bin/manor-host" port-pipe 8080 --host ::1',
      'exec "$HOME/.manor/bin/manor-host" port-pipe 8081',
    ]);
  });

  it("rejects an invalid remote port", async () => {
    const m = makeProvider();
    tracked(m);
    await expect(m.provider.forwardPort(70000)).rejects.toThrow(/Invalid remote port/);
  });

  it("uses the preferred local port when free, and any other when not", async () => {
    const m = makeProvider();
    tracked(m);
    const first = await m.provider.forwardPort(3000);
    const again = await m.provider.forwardPort(3000, { preferredLocalPort: first.localPort });
    expect(again.localPort).not.toBe(first.localPort);
    const port = first.localPort;
    first.dispose();
    await new Promise((r) => setTimeout(r, 20));
    const reused = await m.provider.forwardPort(3000, { preferredLocalPort: port });
    expect(reused.localPort).toBe(port);
  });

  it("closes the local connection when the child exits, and kills the child when it closes", async () => {
    const m = makeProvider();
    tracked(m);
    const forward = await m.provider.forwardPort(5173);
    const a = await open(forward.localPort);
    const b = await open(forward.localPort);
    await vi.waitFor(() => expect(m.children).toHaveLength(2));
    // Accept order need not match connect order: match each child by its bytes.
    const gotA = collect(a);
    collect(b);
    a.write("a");
    b.write("b");
    await vi.waitFor(() => expect(m.children.every((c) => c.written !== "")).toBe(true));
    const childA = m.children.find((c) => c.written === "a")!;
    const childB = m.children.find((c) => c.written === "b")!;

    // The box's port closed: port-pipe exits, and the local socket follows.
    await vi.waitFor(() => expect(gotA()).toBe("a"));
    childA.exit(0);
    await closed(a);
    expect(childB.killed).toBe(false);

    // The local client closing kills its child.
    b.destroy();
    await vi.waitFor(() => expect(childB.killed).toBe(true));
    expect(childA.killed).toBe(false);
  });

  it("dispose closes every listener and kills every child", async () => {
    const m = makeProvider();
    tracked(m);
    const one = await m.provider.forwardPort(5173);
    const two = await m.provider.forwardPort(6006);
    const a = await open(one.localPort);
    const b = await open(two.localPort);
    await vi.waitFor(() => expect(m.children).toHaveLength(2));

    await m.provider.dispose();
    expect(m.children.every((c) => c.killed)).toBe(true);
    await Promise.all([closed(a), closed(b)]);
    await expect(connect(one.localPort)).rejects.toThrow(/ECONNREFUSED/);
    await expect(connect(two.localPort)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("a forward's own dispose kills only its children", async () => {
    const m = makeProvider();
    tracked(m);
    const one = await m.provider.forwardPort(5173);
    const two = await m.provider.forwardPort(6006);
    await open(one.localPort);
    const b = await open(two.localPort);
    await vi.waitFor(() => expect(m.children).toHaveLength(2));
    const twoChild = m.children.find((c) => c.args[c.args.length - 1]?.includes("6006"))!;
    const oneChild = m.children.find((c) => c.args[c.args.length - 1]?.includes("5173"))!;

    one.dispose();
    expect(oneChild.killed).toBe(true);
    expect(twoChild.killed).toBe(false);
    const gotB = collect(b);
    b.write("still\n");
    await vi.waitFor(() => expect(gotB()).toBe("still\n"));
  });

  it("refuses connections once the transport is disposed", async () => {
    const m = makeProvider();
    tracked(m);
    const forward = await m.provider.forwardPort(5173);
    await m.provider.transport().dispose();
    const a = await open(forward.localPort);
    await closed(a);
    expect(m.spawn).not.toHaveBeenCalled();
  });
});
