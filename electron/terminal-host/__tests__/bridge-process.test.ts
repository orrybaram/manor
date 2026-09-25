/**
 * `manor-host remote-bridge` as a real process: the daemon entry, bundled the
 * way the release build bundles it, run under plain Node with a throwaway
 * $HOME. Covers what the in-process bridge tests cannot — that the bridge
 * really spawns a daemon, that the daemon does not hold the bridge's stderr
 * (it would keep an ssh session open forever), and that the bridge process
 * exits once the daemon goes away.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "vite";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Socket paths are capped at 104 bytes on macOS; keep temp dirs short. */
const TMP_BASE = process.platform === "darwin" ? "/tmp" : os.tmpdir();

/** Env for the bridge (and, inherited, the daemon it spawns). */
function childEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    NODE_PATH: path.join(REPO_ROOT, "node_modules"),
    ...extra,
  };
}

let bundleDir: string;
let bundle: string;

beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(TMP_BASE, "mbb-"));
  await build({
    configFile: false,
    logLevel: "silent",
    root: REPO_ROOT,
    build: {
      ssr: path.join(REPO_ROOT, "electron/terminal-host/index.ts"),
      outDir: bundleDir,
      emptyOutDir: true,
      minify: false,
      // The same externals as the release bundle (vite.config.ts); the
      // child resolves them through NODE_PATH.
      rollupOptions: {
        external: ["node-pty", "tree-kill", "@xterm/headless", "@xterm/addon-serialize"],
        output: { format: "cjs", entryFileNames: "terminal-host-index.js" },
      },
    },
    ssr: { noExternal: true, target: "node" },
  });
  bundle = path.join(bundleDir, "terminal-host-index.js");
}, 120_000);

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

/** NDJSON reader over a child's stdout. */
function lineReader(child: ChildProcess): () => Promise<string> {
  let buffer = "";
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    }
  });
  return () =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise((resolve) => waiters.push(resolve));
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${label}`)), ms),
    ),
  ]);
}

describe("manor-host remote-bridge (real process)", () => {
  let home: string;
  let bridge: ChildProcess | null = null;

  const daemonDir = () => path.join(home, ".manor", "daemon");
  const daemonPid = (): number | null => {
    try {
      return parseInt(
        fs.readFileSync(path.join(daemonDir(), "terminal-host.pid"), "utf-8"),
        10,
      );
    } catch {
      return null;
    }
  };

  afterEach(() => {
    bridge?.kill("SIGKILL");
    bridge = null;
    const pid = daemonPid();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("spawns a daemon, announces it, pumps a ping, and exits when the daemon dies", async () => {
    home = fs.mkdtempSync(path.join(TMP_BASE, "mbh-"));
    const child = spawn(process.execPath, [bundle, "remote-bridge"], {
      env: childEnv(home, { MANOR_VERSION: "9.9.9-test" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    bridge = child;
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    const nextLine = lineReader(child);

    const hello = JSON.parse(await withTimeout(nextLine(), 15_000, "bridgeHello"));
    expect(hello.type).toBe("bridgeHello");
    expect(hello.daemonVersion).toBe("9.9.9-test");
    expect(hello.token).toBe(
      fs.readFileSync(path.join(daemonDir(), "terminal-host.token"), "utf-8").trim(),
    );

    child.stdin!.write(
      JSON.stringify({ type: "auth", token: hello.token, requestId: "1" }) + "\n",
    );
    expect(JSON.parse(await withTimeout(nextLine(), 5_000, "authOk"))).toMatchObject({
      type: "authOk",
      requestId: "1",
    });
    child.stdin!.write(JSON.stringify({ type: "ping", requestId: "2" }) + "\n");
    expect(JSON.parse(await withTimeout(nextLine(), 5_000, "pong"))).toEqual({
      type: "pong",
      requestId: "2",
    });

    // A request type this daemon does not know gets an answer, not silence.
    child.stdin!.write(JSON.stringify({ type: "fromTheFuture", requestId: "3" }) + "\n");
    expect(JSON.parse(await withTimeout(nextLine(), 5_000, "unknown"))).toEqual({
      type: "error",
      message: "unknown request type: fromTheFuture",
      requestId: "3",
    });

    // The daemon logs to a file, never to the bridge's stderr.
    expect(fs.existsSync(path.join(daemonDir(), "terminal-host.log"))).toBe(true);
    expect(stderr).not.toContain("[terminal-host");

    const pid = daemonPid();
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, "SIGTERM");

    // stdin is still open: only the daemon going away can end the bridge.
    expect(await withTimeout(exitOf(child), 10_000, "bridge exit")).toBe(0);
  }, 60_000);

  it("exits non-zero without a hello when no daemon can be started", async () => {
    home = fs.mkdtempSync(path.join(TMP_BASE, "mbh-"));
    // A file where the daemon dir should be: the spawn cannot even begin.
    fs.mkdirSync(path.join(home, ".manor"));
    fs.writeFileSync(path.join(home, ".manor", "daemon"), "");

    const child = spawn(process.execPath, [bundle, "remote-bridge"], {
      env: childEnv(home),
      stdio: ["pipe", "pipe", "pipe"],
    });
    bridge = child;
    let stdout = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));

    expect(await withTimeout(exitOf(child), 10_000, "bridge exit")).toBe(1);
    expect(stdout).toBe("");
  }, 30_000);
});
