import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SshTransport, type SshChild } from "../transport-ssh";
import {
  SshAuthError,
  buildSshArgs,
  createManagedSshConfig,
  isRemoteAuthError,
  remoteBridgeCommand,
  renderSshConfig,
  shellQuote,
} from "../ssh-config";

/** A stand-in for an ssh child process: piped stdio and nothing else. */
class FakeChild extends EventEmitter implements SshChild {
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
  }

  kill(): boolean {
    if (!this.killed) {
      this.killed = true;
      setImmediate(() => this.emit("close", null, "SIGTERM"));
    }
    return true;
  }

  /** Exit on its own with `code`, the way ssh does after a failure. */
  exit(code: number): void {
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    const child = new FakeChild(command, args);
    children.push(child);
    return child;
  });
  return { spawn, children };
}

async function nextChild(children: FakeChild[], index: number): Promise<FakeChild> {
  await vi.waitFor(() => expect(children.length).toBeGreaterThan(index));
  return children[index];
}

const hello = (token: string, daemonVersion: string | null = "1.2.3") =>
  JSON.stringify({ type: "bridgeHello", token, daemonVersion }) + "\n";

describe("shellQuote", () => {
  it("passes allowlisted values through", () => {
    expect(shellQuote("user@box.example.com")).toBe("user@box.example.com");
    expect(shellQuote("a-b_c+d=e:f,g./h%i")).toBe("a-b_c+d=e:f,g./h%i");
  });

  it("single-quotes everything else", () => {
    expect(shellQuote("has space")).toBe("'has space'");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("ssh argument construction", () => {
  it("builds the bridge invocation for control and stream", () => {
    expect(buildSshArgs("/cfg/config", "me@box", remoteBridgeCommand(false))).toEqual([
      "-F",
      "/cfg/config",
      "-T",
      "me@box",
      'exec "$HOME/.manor/bin/manor-host" remote-bridge',
    ]);
    expect(remoteBridgeCommand(true)).toBe(
      'exec "$HOME/.manor/bin/manor-host" remote-bridge --stream',
    );
  });

  it("rejects targets ssh would read as an option", () => {
    expect(() => buildSshArgs("/c", "-oProxyCommand=evil", "x")).toThrow(/Invalid ssh target/);
    expect(() => new SshTransport("")).toThrow(/Invalid ssh target/);
    expect(() => new SshTransport("a b")).toThrow(/Invalid ssh target/);
  });

  it("does not add a reverse forward", () => {
    const args = buildSshArgs("/c", "box", remoteBridgeCommand(false));
    expect(args).not.toContain("-R");
  });

  it("renders a ControlMaster config ahead of the user's own", () => {
    const text = renderSshConfig("/tmp/x/ctl");
    const lines = text.split("\n").map((l) => l.trim());
    for (const expected of [
      "ControlMaster auto",
      "ControlPath /tmp/x/ctl",
      "ControlPersist 60",
      "ServerAliveInterval 30",
      "ServerAliveCountMax 3",
    ]) {
      expect(lines).toContain(expected);
    }
    expect(lines.indexOf("ControlPath /tmp/x/ctl")).toBeLessThan(
      lines.indexOf("Include ~/.ssh/config"),
    );
  });
});

describe("isRemoteAuthError", () => {
  it("matches ssh's auth failures", () => {
    expect(isRemoteAuthError("me@box: Permission denied (publickey).")).toBe(true);
    expect(isRemoteAuthError("Permission denied (publickey,password).")).toBe(true);
    expect(isRemoteAuthError("Permission denied (keyboard-interactive).")).toBe(true);
    expect(isRemoteAuthError("Permission denied (password).")).toBe(true);
  });

  it("ignores other failures", () => {
    expect(isRemoteAuthError("ssh: Could not resolve hostname box")).toBe(false);
    expect(isRemoteAuthError("bash: Permission denied")).toBe(false);
  });
});

describe("SshTransport", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-transport-test-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function makeTransport(overrides: Partial<ConstructorParameters<typeof SshTransport>[1]> = {}) {
    const fake = fakeSpawn();
    const transport = new SshTransport("me@box", {
      spawn: fake.spawn,
      configBaseDir: baseDir,
      ...overrides,
    });
    return { transport, ...fake };
  }

  it("uses a 60s handshake timeout by default", () => {
    expect(new SshTransport("box").handshakeTimeoutMs).toBe(60_000);
  });

  it("writes a 0700 managed config dir and exposes the ControlMaster path", async () => {
    const { transport } = makeTransport();
    expect(transport.controlPath).toBeNull();
    await transport.ensureRunning("1.2.3");
    const config = transport.managedConfig();
    expect(fs.statSync(config.dir).mode & 0o777).toBe(0o700);
    expect(transport.controlPath).toBe(path.join(config.dir, "ctl"));
    expect(transport.configPath).toBe(config.configPath);
    expect(fs.readFileSync(config.configPath, "utf-8")).toContain(
      `ControlPath ${config.controlPath}`,
    );
  });

  it("delegates ensureRunning to the injected bootstrap", async () => {
    const ensureRemoteHost = vi.fn(async () => {});
    const { transport } = makeTransport({ ensureRemoteHost });
    await transport.ensureRunning("9.9.9");
    expect(ensureRemoteHost).toHaveBeenCalledWith("me@box", "9.9.9", expect.any(Function));
  });

  it("strips the hello line, caches its token, and passes later bytes through", async () => {
    const { transport, children } = makeTransport();
    const pending = transport.connectControl();
    const child = await nextChild(children, 0);

    expect(child.command).toBe("ssh");
    expect(child.args).toEqual([
      "-F",
      transport.configPath,
      "-T",
      "me@box",
      'exec "$HOME/.manor/bin/manor-host" remote-bridge',
    ]);

    // Hello and the first protocol bytes arrive in one chunk, preceded by rc noise.
    child.stdout.write("Welcome to box\n" + hello("tok-1") + '{"type":"authOk"}\n');
    const duplex = await pending;
    expect(await transport.authToken()).toBe("tok-1");
    expect(transport.daemonVersion).toBe("1.2.3");

    const received: string[] = [];
    duplex.on("data", (c: Buffer) => received.push(c.toString("utf-8")));
    child.stdout.write('{"type":"pong"}\n');
    await vi.waitFor(() =>
      expect(received.join("")).toBe('{"type":"authOk"}\n{"type":"pong"}\n'),
    );

    duplex.write('{"type":"ping"}\n');
    await vi.waitFor(() => expect(child.written).toBe('{"type":"ping"}\n'));
  });

  it("handles a hello split across chunks", async () => {
    const { transport, children } = makeTransport();
    const pending = transport.connectStream();
    const child = await nextChild(children, 0);
    expect(child.args.at(-1)).toBe(
      'exec "$HOME/.manor/bin/manor-host" remote-bridge --stream',
    );
    const line = hello("tok-2");
    child.stdout.write(line.slice(0, 10));
    child.stdout.write(line.slice(10));
    await pending;
    expect(await transport.authToken()).toBe("tok-2");
  });

  it("throws an ssh-add hint when ssh reports Permission denied", async () => {
    const { transport, children } = makeTransport();
    const pending = transport.connectControl();
    const child = await nextChild(children, 0);
    child.stderr.write("me@box: Permission denied (publickey).\r\n");
    await new Promise((r) => setImmediate(r));
    child.exit(255);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshAuthError);
    expect((err as Error).message).toContain("ssh me@box");
    expect((err as Error).message).toContain("ssh-add");
  });

  it("reports other early exits with ssh's stderr", async () => {
    const { transport, children } = makeTransport();
    const pending = transport.connectControl();
    const child = await nextChild(children, 0);
    child.stderr.write("ssh: Could not resolve hostname box\n");
    await new Promise((r) => setImmediate(r));
    child.exit(255);
    await expect(pending).rejects.toThrow(/exited \(code 255\).*Could not resolve hostname/);
  });

  it("times out waiting for the hello and kills ssh", async () => {
    const { transport, children } = makeTransport({ handshakeTimeoutMs: 20 });
    const pending = transport.connectControl();
    const child = await nextChild(children, 0);
    await expect(pending).rejects.toThrow(/Timed out/);
    expect(child.killed).toBe(true);
  });

  it("closes the duplex when ssh exits, and kills ssh when the duplex is destroyed", async () => {
    const { transport, children } = makeTransport();

    const first = transport.connectControl();
    const a = await nextChild(children, 0);
    a.stdout.write(hello("t"));
    const duplexA = await first;
    const closedA = new Promise((r) => duplexA.on("close", r));
    a.exit(0);
    await closedA;

    const second = transport.connectControl();
    const b = await nextChild(children, 1);
    b.stdout.write(hello("t"));
    const duplexB = await second;
    duplexB.destroy();
    expect(b.killed).toBe(true);
  });

  it("dispose closes the ControlMaster and removes the config dir", async () => {
    const { transport, children } = makeTransport();
    await transport.ensureRunning();
    const dir = transport.managedConfig().dir;
    const configPath = transport.configPath;

    const disposing = transport.dispose();
    const ctl = await nextChild(children, 0);
    expect(ctl.args).toEqual(["-F", configPath, "-O", "exit", "me@box"]);
    ctl.exit(0);
    await disposing;

    expect(fs.existsSync(dir)).toBe(false);
    expect(transport.controlPath).toBeNull();
  });

  it("restart runs `manor-host restart` on the remote", async () => {
    const { transport, children } = makeTransport();
    const restarting = transport.restart();
    const child = await nextChild(children, 0);
    expect(child.args).toEqual([
      "-F",
      transport.configPath,
      "-T",
      "me@box",
      'exec "$HOME/.manor/bin/manor-host" restart',
    ]);
    child.exit(0);
    await restarting;
  });

  it("restart surfaces a failing remote command", async () => {
    const { transport, children } = makeTransport();
    const restarting = transport.restart();
    const child = await nextChild(children, 0);
    child.stderr.write("sh: manor-host: not found\n");
    await new Promise((r) => setImmediate(r));
    child.exit(127);
    await expect(restarting).rejects.toThrow(/code 127.*not found/);
  });

  it("exec collects output and feeds stdin", async () => {
    const { transport, children } = makeTransport();
    const running = transport.exec("cat", { stdin: "payload" });
    const child = await nextChild(children, 0);
    await vi.waitFor(() => expect(child.written).toBe("payload"));
    child.stdout.write("out");
    child.stderr.write("err");
    await new Promise((r) => setImmediate(r));
    child.exit(3);
    await expect(running).resolves.toEqual({ code: 3, stdout: "out", stderr: "err" });
  });

  it("exec translates auth failures", async () => {
    const { transport, children } = makeTransport();
    const running = transport.exec("true");
    const child = await nextChild(children, 0);
    child.stderr.write("Permission denied (publickey).\n");
    await new Promise((r) => setImmediate(r));
    child.exit(255);
    await expect(running).rejects.toBeInstanceOf(SshAuthError);
  });

  it("createManagedSshConfig makes distinct dirs", () => {
    const a = createManagedSshConfig(baseDir);
    const b = createManagedSshConfig(baseDir);
    expect(a.dir).not.toBe(b.dir);
  });
});
