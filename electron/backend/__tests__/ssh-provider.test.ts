import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SshHostProvider, forwardSpec } from "../providers/ssh-provider";
import { createProvider } from "../providers";
import { SshTransport, type SshChild } from "../../terminal-host/transport-ssh";

/** An `ssh -O …` child that exits with `code` (and `stderr`) on the next tick. */
class FakeChild extends EventEmitter implements SshChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor(
    readonly args: string[],
    code: number,
    stderr = "",
  ) {
    super();
    setImmediate(() => {
      if (stderr) this.stderr.write(stderr);
      setImmediate(() => this.emit("close", code, null));
    });
  }

  kill(): boolean {
    return true;
  }
}

describe("SshHostProvider", () => {
  let baseDir: string;
  let transport: SshTransport;
  let calls: string[][];
  let exitCode: number;
  let stderr: string;

  const spawn = vi.fn((_command: string, args: string[]) => {
    calls.push(args);
    return new FakeChild(args, exitCode, stderr);
  });

  const makeProvider = () =>
    new SshHostProvider("me@box", {
      transport,
      spawn,
      findFreePort: async () => 54321,
    });

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-provider-test-"));
    transport = new SshTransport("me@box", { configBaseDir: baseDir });
    calls = [];
    exitCode = 0;
    stderr = "";
    spawn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("is an always-on box with no managed capabilities", async () => {
    const provider = makeProvider();
    expect(provider.kind).toBe("ssh");
    expect(provider.capabilities).toEqual({
      autoSleep: false,
      persistsMemory: false,
      previewUrls: false,
    });
    expect(provider.transport()).toBe(transport);
    await expect(provider.ensureUp()).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("builds forward and cancel args against the managed config", async () => {
    const { configPath } = transport.managedConfig();
    const provider = makeProvider();
    const forward = await provider.forwardPort(3000);
    expect(forward.localPort).toBe(54321);
    expect(calls).toEqual([
      ["-F", configPath, "-O", "forward", "-L", "54321:127.0.0.1:3000", "me@box"],
    ]);

    forward.dispose();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual([
      "-F", configPath, "-O", "cancel", "-L", "54321:127.0.0.1:3000", "me@box",
    ]);
    // A second dispose does not cancel twice.
    forward.dispose();
    await provider.dispose();
    expect(calls).toHaveLength(2);
  });

  it("cancels every live forward on dispose", async () => {
    transport.managedConfig();
    let next = 40000;
    const provider = new SshHostProvider("me@box", {
      transport,
      spawn,
      findFreePort: async () => next++,
    });
    await provider.forwardPort(3000);
    await provider.forwardPort(5173);
    await provider.dispose();
    expect(calls.slice(2).map((args) => args.slice(3, 6))).toEqual([
      ["cancel", "-L", "40000:127.0.0.1:3000"],
      ["cancel", "-L", "40001:127.0.0.1:5173"],
    ]);
  });

  it("refuses to forward before the transport has connected", async () => {
    await expect(makeProvider().forwardPort(3000)).rejects.toThrow(/not connected/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects invalid ports", async () => {
    transport.managedConfig();
    await expect(makeProvider().forwardPort(0)).rejects.toThrow(/Invalid remote port/);
    await expect(makeProvider().forwardPort(70000)).rejects.toThrow(/Invalid remote port/);
  });

  it("reports ssh's complaint when the forward fails", async () => {
    transport.managedConfig();
    exitCode = 255;
    stderr = "Port forwarding failed.\n";
    await expect(makeProvider().forwardPort(3000)).rejects.toThrow(
      /could not forward port 3000 on me@box: Port forwarding failed/,
    );
    // Nothing to cancel later.
    const provider = makeProvider();
    await provider.dispose();
    expect(calls).toHaveLength(1);
  });

  it("maps the ControlMaster check to a status", async () => {
    const provider = makeProvider();
    await expect(provider.status()).resolves.toBe("unreachable");
    const { configPath } = transport.managedConfig();
    await expect(provider.status()).resolves.toBe("up");
    expect(calls[0]).toEqual(["-F", configPath, "-O", "check", "me@box"]);
    exitCode = 255;
    await expect(provider.status()).resolves.toBe("unreachable");
  });
});

describe("forwardSpec", () => {
  it("binds loopback to the box's loopback", () => {
    expect(forwardSpec(8080, 3000)).toEqual(["-L", "8080:127.0.0.1:3000"]);
  });
});

describe("createProvider", () => {
  it("builds an SshHostProvider for an ssh spec", () => {
    const provider = createProvider({ kind: "ssh", target: "me@box" });
    expect(provider).toBeInstanceOf(SshHostProvider);
    expect(provider.transport()).toBeInstanceOf(SshTransport);
  });
});
