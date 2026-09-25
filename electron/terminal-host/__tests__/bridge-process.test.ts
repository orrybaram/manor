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
      // child resolves them through NODE_PATH. `electron` is external too, as
      // vite-plugin-electron makes it, so an import of it shows up as a
      // `require("electron")` the Electron-free check below can see.
      rollupOptions: {
        external: [
          "node-pty",
          "tree-kill",
          "@xterm/headless",
          "@xterm/addon-serialize",
          "electron",
        ],
        output: { format: "cjs", entryFileNames: "terminal-host-index.js" },
      },
    },
    ssr: { noExternal: true, target: "node" },
  });
  bundle = path.join(bundleDir, "terminal-host-index.js");
  // The manor-host tarball ships agent-hook.js next to the daemon bundle
  // (scripts/build-host-tarball.mjs); `bootstrap` copies it into ~/.manor/hooks.
  fs.copyFileSync(
    path.join(REPO_ROOT, "electron/scripts/agent-hook.js"),
    path.join(bundleDir, "agent-hook.js"),
  );
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

  it("the daemon bundle is Electron-free", () => {
    // A remote host has no Electron; one stray import and the daemon dies at
    // load time there while working fine on the laptop.
    const source = fs.readFileSync(bundle, "utf-8");
    expect(source).not.toMatch(/require\(\s*["']electron["']\s*\)/);
    expect(source).not.toMatch(/from\s*["']electron["']/);
  });

  it("bootstraps its own host: zdotdir, hook scripts, agent configs", async () => {
    home = fs.mkdtempSync(path.join(TMP_BASE, "mbh-"));
    const child = spawn(process.execPath, [bundle, "remote-bridge"], {
      env: childEnv(home),
      stdio: ["pipe", "pipe", "pipe"],
    });
    bridge = child;
    const nextLine = lineReader(child);

    const hello = JSON.parse(await withTimeout(nextLine(), 15_000, "bridgeHello"));
    child.stdin!.write(
      JSON.stringify({ type: "auth", token: hello.token, requestId: "1" }) + "\n",
    );
    expect(JSON.parse(await withTimeout(nextLine(), 5_000, "authOk")).type).toBe("authOk");

    child.stdin!.write(JSON.stringify({ type: "bootstrap", requestId: "2" }) + "\n");
    const resp = JSON.parse(await withTimeout(nextLine(), 10_000, "bootstrapped"));
    expect(resp).toMatchObject({ type: "bootstrapped", requestId: "2" });
    expect(resp.agents).toEqual(expect.arrayContaining(["claude", "codex"]));

    // Hook scripts, with the real Node implementation next to the wrapper.
    const hooksDir = path.join(home, ".manor", "hooks");
    const notifySh = path.join(hooksDir, "notify.sh");
    expect(fs.readFileSync(notifySh, "utf-8")).toContain('exec node "$(dirname "$0")/notify.js"');
    expect(fs.statSync(notifySh).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(hooksDir, "notify.js"), "utf-8")).toBe(
      fs.readFileSync(path.join(REPO_ROOT, "electron/scripts/agent-hook.js"), "utf-8"),
    );

    // The zdotdir every daemon-spawned shell starts in.
    const dataDir =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Manor")
        : path.join(home, ".local", "share", "Manor");
    expect(fs.readFileSync(path.join(dataDir, "zdotdir", ".zshrc"), "utf-8")).toContain(
      "__manor_osc7_precmd",
    );

    // Agent configs point at this host's hook script...
    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"),
    );
    expect(JSON.stringify(claudeSettings.hooks.Stop)).toContain(notifySh);
    // ...but no MCP server: the webview server it talks to is on the laptop.
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
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
