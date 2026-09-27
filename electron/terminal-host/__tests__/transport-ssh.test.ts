import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SshTransport, type SshChild } from "../transport-ssh";
import { execFileSync } from "node:child_process";
import {
  SshAuthError,
  SshHostKeyError,
  assertValidTarget,
  buildControlArgs,
  buildSshArgs,
  createManagedSshConfig,
  isHostKeyError,
  isRemoteAuthError,
  parseControlPath,
  remoteBridgeCommand,
  remoteShellCommand,
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
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });
});

describe("remoteShellCommand", () => {
  // A snippet exercising what the bootstrap relies on: quotes inside quotes,
  // $(...), redirections, if/then, and a literal `\n` for printf.
  const snippet =
    `x=$(printf '%s\\n' ${shellQuote("it's $HOME")}); ` +
    `if [ -n "$x" ]; then printf '%s|' "$x"; fi 2>/dev/null`;

  const shells = ["sh", "bash", "zsh", "fish", "tcsh", "csh"].filter((sh) => {
    try {
      execFileSync("sh", ["-c", `command -v ${sh}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });

  it.each(shells)("runs the snippet under sh when the login shell is %s", (loginShell) => {
    const out = execFileSync(loginShell, ["-c", remoteShellCommand(snippet)], {
      encoding: "utf-8",
      env: { ...process.env, HOME: "/home/x" },
    });
    expect(out).toBe("it's $HOME|");
  });

  it("rejects snippets the login shell would mangle", () => {
    expect(() => remoteShellCommand("a\nb")).toThrow(/single-line/);
    expect(() => remoteShellCommand("echo \\\\")).toThrow(/single-line/);
    expect(() => remoteShellCommand("echo 'a\\'")).toThrow(/single-line/);
    expect(() => remoteShellCommand("echo '#!/bin/sh'")).toThrow(/history reference/);
    expect(() => remoteShellCommand("if ! true; then :; fi")).not.toThrow();
  });
});

describe("ssh argument construction", () => {
  it("builds the bridge invocation for control and stream", () => {
    expect(buildSshArgs("/cfg/config", "me@box", remoteBridgeCommand(false))).toEqual([
      "-F",
      "/cfg/config",
      "-T",
      "me@box",
      `exec sh -c 'exec "$HOME/.manor/bin/manor-host" remote-bridge'`,
    ]);
    expect(remoteBridgeCommand(true)).toBe(
      'exec "$HOME/.manor/bin/manor-host" remote-bridge --stream',
    );
  });

  it("rejects targets ssh would read as an option", () => {
    expect(() => buildSshArgs("/c", "-oProxyCommand=evil", "x")).toThrow(/Invalid ssh target/);
    expect(() => new SshTransport("")).toThrow(/Invalid ssh target/);
    expect(() => new SshTransport("a b")).toThrow(/Invalid ssh target/);
    expect(() => assertValidTarget("ssh://-oProxyCommand=evil")).toThrow(/Invalid ssh target/);
  });

  it.each([
    "box",
    "me@box.example.com",
    "first.last@10.0.0.1",
    "me@[fe80::1%en0]:2222",
    "fe80::1",
    "ssh://me@box:2222",
    "my-alias_2",
  ])("accepts target %j", (target) => {
    expect(() => assertValidTarget(target)).not.toThrow();
  });

  it.each(["box;rm -rf /", "box\n", "$(whoami)@box", "a'b", "ssh://", "me@box/path", "a\tb"])(
    "rejects target %j",
    (target) => {
      expect(() => assertValidTarget(target)).toThrow(/Invalid ssh target/);
    },
  );

  it("builds ControlMaster operations against the managed config", () => {
    expect(buildControlArgs("/c", "box", "exit")).toEqual(["-F", "/c", "-O", "exit", "box"]);
    expect(buildControlArgs("/c", "box", "forward", ["-L", "8080:localhost:80"])).toEqual([
      "-F",
      "/c",
      "-O",
      "forward",
      "-L",
      "8080:localhost:80",
      "box",
    ]);
  });

  it("reads the expanded ControlPath from ssh -G output", () => {
    expect(
      parseControlPath("user me\nhostname box\ncontrolpath /tmp/manor-ssh-a/0123abcd\nport 22\n"),
    ).toBe("/tmp/manor-ssh-a/0123abcd");
    expect(parseControlPath("controlpath none\n")).toBeNull();
    expect(parseControlPath("user me\n")).toBeNull();
  });

  it("does not add a reverse forward", () => {
    const args = buildSshArgs("/c", "box", remoteBridgeCommand(false));
    expect(args).not.toContain("-R");
  });

  it("renders a ControlMaster config ahead of the user's own", () => {
    const text = renderSshConfig("/tmp/x/%C");
    const lines = text.split("\n").map((l) => l.trim());
    for (const expected of [
      "ControlMaster auto",
      "ControlPath /tmp/x/%C",
      "ControlPersist 60",
      "ServerAliveInterval 30",
      "ServerAliveCountMax 3",
    ]) {
      expect(lines).toContain(expected);
    }
    expect(lines.indexOf("ControlPath /tmp/x/%C")).toBeLessThan(
      lines.indexOf("Include ~/.ssh/config"),
    );
  });

  it("includes nothing extra unless the E2E test config is given", () => {
    const text = renderSshConfig("/tmp/x/%C", undefined);
    expect(text.match(/Include/g)).toHaveLength(2);
  });

  it("includes the E2E test config ahead of the user's own", () => {
    const lines = renderSshConfig("/tmp/x/%C", "/tmp/e2e/ssh_config")
      .split("\n")
      .map((l) => l.trim());
    expect(lines.indexOf("Include /tmp/e2e/ssh_config")).toBeGreaterThan(-1);
    expect(lines.indexOf("Include /tmp/e2e/ssh_config")).toBeLessThan(
      lines.indexOf("Include ~/.ssh/config"),
    );
    expect(() => renderSshConfig("/tmp/x/%C", "relative/config")).toThrow();
    expect(() => renderSshConfig("/tmp/x/%C", "/tmp/with space")).toThrow();
  });
});

describe("isHostKeyError", () => {
  it("matches an unknown or changed host key", () => {
    expect(isHostKeyError("No ED25519 host key is known for box and you have requested strict checking.\r\nHost key verification failed.\r\n")).toBe(true);
    expect(isHostKeyError("@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @")).toBe(true);
    expect(isHostKeyError("Permission denied (publickey).")).toBe(false);
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

  it("writes a 0700 managed config dir with a per-host ControlPath", async () => {
    const { transport } = makeTransport();
    expect(transport.configPath).toBeNull();
    await transport.ensureRunning("1.2.3");
    const config = transport.managedConfig();
    expect(fs.statSync(config.dir).mode & 0o777).toBe(0o700);
    // %C, not a fixed name: with ProxyJump the jump host's ssh reads this
    // config too, and a fixed path would let its master capture the socket.
    expect(config.controlPath).toBe(path.join(config.dir, "%C"));
    expect(transport.configPath).toBe(config.configPath);
    expect(fs.readFileSync(config.configPath, "utf-8")).toContain(
      `ControlPath ${config.controlPath}`,
    );
  });

  it("keeps the default ControlMaster socket path under the unix limit", () => {
    const config = createManagedSshConfig();
    try {
      // 40-char %C hash plus ssh's 17-char temporary suffix.
      expect(path.join(config.dir, "x".repeat(40)).length + 17).toBeLessThan(104);
    } finally {
      fs.rmSync(config.dir, { recursive: true, force: true });
    }
  });

  it("resolves the expanded ControlMaster socket with ssh -G", async () => {
    const { transport, children } = makeTransport();
    expect(await transport.resolveControlPath()).toBeNull();
    transport.managedConfig();
    const resolving = transport.resolveControlPath();
    const child = await nextChild(children, 0);
    expect(child.args).toEqual(["-F", transport.configPath, "-G", "me@box"]);
    child.stdout.write("user me\ncontrolpath /tmp/manor-ssh-x/abc123\n");
    await new Promise((r) => setImmediate(r));
    child.exit(0);
    expect(await resolving).toBe("/tmp/manor-ssh-x/abc123");
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
      `exec sh -c 'exec "$HOME/.manor/bin/manor-host" remote-bridge'`,
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
    expect(child.args[child.args.length - 1]).toBe(
      `exec sh -c 'exec "$HOME/.manor/bin/manor-host" remote-bridge --stream'`,
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

  it("tells the user to accept an unknown host key from a terminal", async () => {
    const { transport, children } = makeTransport();
    const pending = transport.connectControl();
    const child = await nextChild(children, 0);
    child.stderr.write("Host key verification failed.\r\n");
    await new Promise((r) => setImmediate(r));
    child.exit(255);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshHostKeyError);
    expect((err as Error).message).toContain(
      "ssh to me@box once from a terminal to accept its host key",
    );
  });

  it("exec translates host key failures", async () => {
    const { transport, children } = makeTransport();
    const running = transport.exec("true");
    const child = await nextChild(children, 0);
    child.stderr.write("Host key verification failed.\n");
    await new Promise((r) => setImmediate(r));
    child.exit(255);
    await expect(running).rejects.toBeInstanceOf(SshHostKeyError);
  });

  it("gives up once 64KB of pre-hello noise has gone by, even in short lines", async () => {
    const { transport, children } = makeTransport();
    const pending = transport.connectControl();
    const child = await nextChild(children, 0);
    const noise = "motd line\n".repeat(1024); // ~10KB per write, all complete lines
    for (let i = 0; i < 7; i++) child.stdout.write(noise);
    await expect(pending).rejects.toThrow(/did not announce itself/);
    expect(child.killed).toBe(true);
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
    expect(transport.configPath).toBeNull();
  });

  it("refuses to spawn ssh or recreate its config once disposed, until reset", async () => {
    const { transport, children } = makeTransport();
    await transport.dispose(); // never used: no ControlMaster to close
    expect(children).toHaveLength(0);

    await expect(transport.connectControl()).rejects.toThrow(/has been disposed/);
    await expect(transport.connectStream()).rejects.toThrow(/has been disposed/);
    await expect(transport.exec("true")).rejects.toThrow(/has been disposed/);
    await expect(transport.ensureRunning("1.0.0")).rejects.toThrow(/has been disposed/);
    expect(() => transport.managedConfig()).toThrow(/has been disposed/);
    expect(children).toHaveLength(0);
    expect(transport.configPath).toBeNull();

    transport.reset();
    const pending = transport.connectControl();
    const child = await nextChild(children, 0);
    expect(transport.configPath).not.toBeNull();
    child.stdout.write(hello("t"));
    (await pending).destroy();
    const disposing = transport.dispose();
    (await nextChild(children, 1)).exit(0);
    await disposing;
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
      `exec sh -c 'exec "$HOME/.manor/bin/manor-host" restart'`,
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
