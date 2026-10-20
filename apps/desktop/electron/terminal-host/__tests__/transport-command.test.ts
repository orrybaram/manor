/**
 * `CommandTransport` against a real exec prefix: `env HOME=<tmp>`, so every
 * child is a local `env HOME=<tmp> sh -c <snippet>` — the same shape as
 * `kubectl exec -i … -- sh -c <snippet>`. `$HOME/.manor/bin/manor-host` is a
 * stand-in script that says each mode's hello and then echoes stdin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { CommandTransport, commandArgv } from "../transport-command";
import { remoteBridgeCommand } from "../ssh-config";

const FAKE_HOST = `#!/bin/sh
case "$1" in
  remote-bridge)
    echo "Welcome to the pod"
    echo '{"type":"bridgeHello","token":"tok-1"}'
    exec cat ;;
  server-bridge)
    if [ "$MANOR_FAKE_REFUSE" = 1 ]; then
      echo '{"kind":"close","code":"unauthorized","reason":"nope"}'
      exit 0
    fi
    if [ "$MANOR_FAKE_NO_SERVER" = 1 ]; then
      echo "[server-bridge] the host server is not running on this box" >&2
      exit 3
    fi
    if [ "$2" = "--viewer" ]; then
      echo '{"type":"hello","ok":true,"viewer":"desktop"}'
    else
      echo '{"type":"hello","ok":true}'
    fi
    exec cat ;;
  restart)
    exit "\${MANOR_FAKE_RESTART_CODE:-0}" ;;
esac
exit 64
`;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-transport-"));
  const bin = path.join(home, ".manor", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "manor-host"), FAKE_HOST, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function makeTransport(env: Record<string, string> = {}) {
  const argv = ["env", `HOME=${home}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  return new CommandTransport(argv, { handshakeTimeoutMs: 10_000 });
}

/** Write `text` and resolve with what comes back once it is all there. */
async function roundTrip(duplex: Duplex, text: string, expected = text): Promise<string> {
  let got = "";
  duplex.on("data", (c: Buffer) => (got += c.toString("utf-8")));
  duplex.write(text);
  await vi.waitFor(() => expect(got).toBe(expected));
  return got;
}

describe("commandArgv", () => {
  it("runs the snippet under sh after the prefix", () => {
    expect(commandArgv(["kubectl", "exec", "-i", "pod", "--"], "exec x")).toEqual([
      "kubectl",
      "exec",
      "-i",
      "pod",
      "--",
      "sh",
      "-c",
      "exec x",
    ]);
  });

  it("runs sh itself for an empty prefix", () => {
    expect(commandArgv([], remoteBridgeCommand())).toEqual(["sh", "-c", remoteBridgeCommand()]);
  });
});

describe("CommandTransport", () => {
  const transports: CommandTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.dispose()));
  });
  function track(t: CommandTransport): CommandTransport {
    transports.push(t);
    return t;
  }

  it("uses a handshake timeout longer than ssh's by default", () => {
    expect(new CommandTransport(["docker", "exec", "-i", "box"]).handshakeTimeoutMs).toBeGreaterThan(
      60_000,
    );
  });

  it("opens the daemon bridge past its hello and takes the token off it", async () => {
    const transport = track(makeTransport());
    await expect(transport.authToken()).rejects.toThrow(/No bridge/);
    const duplex = await transport.connectControl();
    expect(await transport.authToken()).toBe("tok-1");
    await roundTrip(duplex, '{"id":1}\n');
    duplex.destroy();
  });

  it("opens the owner channel read past the server's hello", async () => {
    const transport = track(makeTransport());
    const duplex = await transport.openServerBridge();
    await roundTrip(duplex, '{"kind":"invoke"}\n');
    duplex.destroy();
  });

  it("opens a viewer stream that keeps the server's hello as its first line", async () => {
    const transport = track(makeTransport());
    const duplex = await transport.openViewerBridge();
    await roundTrip(
      duplex,
      '{"kind":"invoke"}\n',
      '{"type":"hello","ok":true,"viewer":"desktop"}\n{"kind":"invoke"}\n',
    );
    duplex.destroy();
  });

  it("fails the owner channel the server refuses", async () => {
    const transport = track(makeTransport({ MANOR_FAKE_REFUSE: "1" }));
    await expect(transport.openServerBridge()).rejects.toThrow(/refused the owner \(unauthorized: nope\)/);
  });

  it("fails the owner channel with the child's stderr when there is no server", async () => {
    const transport = track(makeTransport({ MANOR_FAKE_NO_SERVER: "1" }));
    await expect(transport.openServerBridge()).rejects.toThrow(
      /env for .* exited \(code 3\) before manor-host answered: \[server-bridge\] the host server is not running/,
    );
  });

  it("reports a prefix that cannot run", async () => {
    const transport = track(new CommandTransport(["/nonexistent/kubectl", "exec", "--"]));
    await expect(transport.connectControl()).rejects.toThrow(/Could not run kubectl for/);
  });

  it("exec returns exit codes and output, and feeds stdin", async () => {
    const transport = track(makeTransport());
    expect(await transport.exec("echo out; echo err >&2; exit 3")).toEqual({
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
    const payload = Buffer.alloc(256 * 1024, 7);
    const { code, stdout } = await transport.exec("wc -c", { stdin: payload });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(String(payload.length));
  });

  it("exec kills a command that outlives its timeout", async () => {
    const transport = track(makeTransport());
    await expect(transport.exec("exec sleep 30", { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it("ensureRunning hands the injected bootstrap an exec over the prefix", async () => {
    const ensureRemoteHost = vi.fn(async (_target: string, _version: string | undefined, exec) => {
      const { stdout } = await exec('printf %s "$HOME"');
      expect(stdout).toBe(home);
    });
    const transport = track(
      new CommandTransport(["env", `HOME=${home}`], { ensureRemoteHost, label: "dev pod" }),
    );
    await transport.ensureRunning("1.2.3");
    expect(ensureRemoteHost).toHaveBeenCalledWith("dev pod", "1.2.3", expect.any(Function));
  });

  it("restart runs `manor-host restart`, and surfaces its failure", async () => {
    await track(makeTransport()).restart();
    await expect(track(makeTransport({ MANOR_FAKE_RESTART_CODE: "5" })).restart()).rejects.toThrow(
      /exited \(code 5\)/,
    );
  });

  it("closes the stream when the child exits, and kills the child on dispose", async () => {
    const transport = track(makeTransport());
    const duplex = await transport.connectStream();
    const closed = new Promise<void>((resolve) => duplex.on("close", () => resolve()));
    await transport.dispose();
    await closed;
  });

  it("refuses to spawn once disposed, until reset", async () => {
    const transport = track(makeTransport());
    await transport.dispose();
    await expect(transport.connectControl()).rejects.toThrow(/has been disposed/);
    await expect(transport.exec("true")).rejects.toThrow(/has been disposed/);
    await expect(transport.ensureRunning()).rejects.toThrow(/has been disposed/);
    transport.reset();
    expect((await transport.exec("true")).code).toBe(0);
  });
});
