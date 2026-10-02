import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

/**
 * A local Manor relay for the e2e suite (ADR-206): `wrangler dev` on a port of
 * its own, with an isolated persist directory whose local R2 bucket holds
 * this checkout's `pnpm build:web:relay` output — and, optionally, a second
 * "other version" copy of it for the version-redirect test.
 *
 * Spawned as a child process, not through wrangler's programmatic
 * `unstable_dev` / `startWorker`: wrangler needs Node >= 22, and Playwright's
 * own Node is whatever ran `playwright test`. A child process only needs a
 * Node 22 `node` on PATH, and when it is not there the failure names the
 * requirement instead of a stack trace from inside wrangler.
 *
 * **The dev payload log.** The relay is started with
 * `--var RELAY_DEV_PAYLOAD_LOG:1`, and the room prints every payload it
 * forwards (`relay/src/room.ts`, `devPayloadLogEnabled`) to wrangler's stdout,
 * which this fixture appends — along with everything else wrangler says — to
 * `logFile`. `payloads()` reads the forwarded payloads back out of it, so a
 * test can show that nothing it typed, and no token, crossed the relay in a
 * readable form.
 */

const repoRoot = path.join(__dirname, "../../..");
const relayDir = path.join(repoRoot, "relay");
const wranglerBin = path.join(
  relayDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

/**
 * `preview_bucket_name` in `relay/wrangler.toml`: `wrangler dev` binds `WEB`
 * to the preview bucket locally, not to `bucket_name`.
 */
const WEB_BUCKET = "manor-relay-web-dev";

/** Mirrors `DEV_PAYLOAD_LOG_PREFIX` in `relay/src/room.ts`. */
const DEV_PAYLOAD_LOG_PREFIX = "[relay-dev-payload]";

/** How long wrangler gets to come up (it bundles the Worker first). */
const READY_TIMEOUT_MS = 90_000;

/** The version `package.json` names — the one the desktop under test runs. */
export function appVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

/** `pnpm build:web:relay`'s output for `version`. */
export function relayWebBuildDir(version = appVersion()): string {
  return path.join(repoRoot, "dist-relay-web", version);
}

export interface ForwardedPayload {
  direction: "host->viewer" | "viewer->host";
  ch: number;
  bytes: Buffer;
}

export interface LocalRelay {
  /** `http://127.0.0.1:<port>` — what `MANOR_RELAY_URL` is set to. */
  readonly url: string;
  /** Everything wrangler printed, across every start. */
  readonly logFile: string;
  /** Kill wrangler. The persist directory (R2, rooms) is kept. */
  stop(): Promise<void>;
  /** Start it again on the same port, against the same state. */
  start(): Promise<void>;
  /** Every payload the room has forwarded so far, decoded. */
  payloads(): ForwardedPayload[];
  /** Stop and delete the persist directory. */
  dispose(): Promise<void>;
}

/**
 * Every `wrangler dev` this process started and has not stopped. A fixture
 * that times out is abandoned rather than torn down, so the worker's own exit
 * is the last chance to take wrangler (and workerd, in its process group)
 * down with it instead of leaving it holding a port.
 */
const liveGroups = new Set<number>();
process.once("exit", () => {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

/** A free TCP port on loopback, for wrangler and its inspector. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

/** The environment wrangler runs in: ours, minus the app's own variables. */
function wranglerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("MANOR_")) continue;
    env[key] = value;
  }
  return {
    ...env,
    WRANGLER_SEND_METRICS: "false",
    // Plain lines: the log is parsed, not read in a terminal.
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

/** Which `node` wrangler will get, for an error message worth reading. */
function nodeOnPath(): string {
  const r = spawnSync("node", ["--version"], {
    env: wranglerEnv(),
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : "none found";
}

function requirementHint(): string {
  return (
    `The relay e2e runs wrangler, which needs Node >= 22 as \`node\` on PATH ` +
    `(found: ${nodeOnPath()}). Put a Node 22 first on PATH and run again.`
  );
}

/**
 * Fail before spawning anything if wrangler cannot run here, with a message
 * that says why — rather than a wrangler banner, or a readiness timeout.
 */
function assertWranglerCanRun(): void {
  if (!fs.existsSync(wranglerBin)) {
    throw new Error(
      `wrangler is not installed at ${wranglerBin} — run \`pnpm install\`.`,
    );
  }
  const major = Number(/^v(\d+)\./.exec(nodeOnPath())?.[1] ?? 0);
  if (major < 22) throw new Error(requirementHint());
}

/** Run wrangler to completion; throws with its output on failure. */
function runWrangler(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(wranglerBin, args, {
      cwd: relayDir,
      env: wranglerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) =>
      reject(new Error(`${err.message}\n${requirementHint()}`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `wrangler ${args.slice(0, 3).join(" ")} exited ${code}:\n` +
              output.slice(-2000),
          ),
        );
    });
  });
}

function* walk(dir: string): Generator<string> {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Put every file of a web build into the local R2 bucket under
 * `app/<version>/…` — what `pnpm relay:dev:upload` does, but into
 * `persistDir` rather than the shared dev state. One at a time: each put is
 * its own wrangler process on the same local SQLite store, and concurrent
 * puts crash workerd.
 */
async function uploadBuild(
  persistDir: string,
  version: string,
  dir: string,
): Promise<void> {
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join("/");
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
    await runWrangler([
      "r2",
      "object",
      "put",
      `${WEB_BUCKET}/app/${version}/${rel}`,
      "--file",
      file,
      ...(type ? ["--content-type", type] : []),
      "--local",
      "--persist-to",
      persistDir,
    ]);
  }
}

/**
 * A copy of this checkout's relay web build that believes it is `other`:
 * every `/app/<version>/` base and the quoted `__APP_VERSION__` literal are
 * rewritten. A page loaded from it is a real build of a different version as
 * far as the version redirect can tell — it talks to the same desktop and
 * finds a different `appVersion` in the hello reply.
 */
export function fakeVersionBuild(other: string, into: string): string {
  const version = appVersion();
  const src = relayWebBuildDir(version);
  const out = path.join(into, other);
  fs.cpSync(src, out, { recursive: true });
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = new RegExp(`/app/${escaped}/`, "g");
  const literal = new RegExp(`(["'\`])${escaped}\\1`, "g");
  let rewritten = 0;
  for (const file of walk(out)) {
    if (![".html", ".js", ".css"].includes(path.extname(file))) continue;
    const text = fs.readFileSync(file, "utf8");
    const next = text
      .replace(base, `/app/${other}/`)
      .replace(literal, (_m, q: string) => `${q}${other}${q}`);
    if (next !== text) {
      rewritten++;
      fs.writeFileSync(file, next);
    }
  }
  if (rewritten === 0) {
    throw new Error(`No ${version} found to rewrite in ${src}`);
  }
  return out;
}

/**
 * Seed a persist directory once: the current build, plus any extra versions
 * (`version → build dir`). Returned as a template that `startLocalRelay`
 * copies, so each test gets fresh rooms without paying for the uploads again.
 */
export async function seedRelayState(
  extra: Record<string, string> = {},
): Promise<string> {
  assertWranglerCanRun();
  const version = appVersion();
  const build = relayWebBuildDir(version);
  if (!fs.existsSync(path.join(build, "web.html"))) {
    throw new Error(
      `No relay web build at ${build}. Run \`pnpm build:web:relay\` first ` +
        `(\`pnpm test:e2e:relay\` does).`,
    );
  }
  const persistDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "manor-relay-e2e-seed-"),
  );
  await uploadBuild(persistDir, version, build);
  for (const [other, dir] of Object.entries(extra)) {
    await uploadBuild(persistDir, other, dir);
  }
  return persistDir;
}

/** Decode the dev payload log lines out of wrangler's output. */
export function parsePayloadLog(text: string): ForwardedPayload[] {
  const out: ForwardedPayload[] = [];
  const pattern = new RegExp(
    `${DEV_PAYLOAD_LOG_PREFIX.replace(/[[\]]/g, "\\$&")} ` +
      `(host->viewer|viewer->host) ch=(\\d+) ([A-Za-z0-9_-]*)`,
    "g",
  );
  for (const m of text.matchAll(pattern)) {
    out.push({
      direction: m[1] as ForwardedPayload["direction"],
      ch: Number(m[2]),
      bytes: Buffer.from(m[3], "base64url"),
    });
  }
  return out;
}

/**
 * Boot `wrangler dev` against a copy of `seedDir` and wait until it serves
 * the current version's `web.html`.
 */
export async function startLocalRelay(seedDir: string): Promise<LocalRelay> {
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-relay-e2e-"));
  fs.cpSync(seedDir, persistDir, { recursive: true });
  const logFile = path.join(persistDir, "wrangler.log");
  const port = await freePort();
  const inspectorPort = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const readyPath = `/app/${appVersion()}/web.html`;

  let child: ChildProcess | null = null;

  const start = async (): Promise<void> => {
    assertWranglerCanRun();
    const log = fs.openSync(logFile, "a");
    const proc = spawn(
      wranglerBin,
      [
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        String(inspectorPort),
        "--persist-to",
        persistDir,
        // The custom-domain route in wrangler.toml would otherwise be the
        // host the Worker sees (`http://relay.manor.sh/…`), and the payload
        // log only runs for a request addressed to loopback.
        "--local-upstream",
        `127.0.0.1:${port}`,
        "--var",
        "RELAY_DEV_PAYLOAD_LOG:1",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: relayDir,
        env: wranglerEnv(),
        stdio: ["ignore", log, log],
        // Its own process group, so stop() takes workerd down with it.
        detached: process.platform !== "win32",
      },
    );
    fs.closeSync(log);
    child = proc;
    const pid = proc.pid;
    if (pid !== undefined && process.platform !== "win32") {
      liveGroups.add(pid);
      proc.once("exit", () => liveGroups.delete(pid));
    }

    let exited: number | null = null;
    proc.once("exit", (code) => {
      exited = code ?? -1;
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited !== null) {
        const output = fs.readFileSync(logFile, "utf8").slice(-3000);
        throw new Error(
          `wrangler dev exited ${exited} before it was ready:\n${output}`,
        );
      }
      try {
        const res = await fetch(url + readyPath);
        await res.arrayBuffer();
        if (res.status === 200) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    await stop();
    throw new Error(
      `wrangler dev did not serve ${readyPath} within ${READY_TIMEOUT_MS} ms:\n` +
        fs.readFileSync(logFile, "utf8").slice(-3000),
    );
  };

  const stop = async (): Promise<void> => {
    const proc = child;
    child = null;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const closed = new Promise<void>((resolve) =>
      proc.once("exit", () => resolve()),
    );
    try {
      if (proc.pid && process.platform !== "win32")
        process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    await closed;
    // The port must be free again before anything dials it expecting a
    // refusal, or before start() binds it again.
    for (let i = 0; i < 40; i++) {
      try {
        await (await fetch(url + readyPath)).arrayBuffer();
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  await start();

  return {
    url,
    logFile,
    start,
    stop,
    payloads: () =>
      parsePayloadLog(
        fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "",
      ),
    async dispose() {
      await stop();
      fs.rmSync(persistDir, { recursive: true, force: true });
    },
  };
}

/**
 * Every form a test string could plausibly take in a payload the relay saw
 * without anything having been decrypted: the UTF-8 bytes themselves, and
 * their hex and base64 / base64url spellings at each of the three byte
 * alignments base64 has (a marker that starts one or two bytes into a
 * base64'd buffer encodes to different characters).
 */
export function readableForms(text: string): string[] {
  const bytes = Buffer.from(text, "utf8");
  const forms = new Set<string>([text, bytes.toString("hex")]);
  for (let pad = 0; pad < 3; pad++) {
    const shifted = Buffer.concat([Buffer.alloc(pad), bytes]);
    for (const enc of ["base64", "base64url"] as const) {
      const full = shifted.toString(enc).replace(/=+$/, "");
      // Drop the characters that mix in the padding bytes or the bytes
      // after the marker; what is left is fixed by the marker alone.
      const lead = Math.ceil((pad * 4) / 3);
      const tail = 2;
      const core = full.slice(lead, full.length - tail);
      if (core.length >= 8) forms.add(core);
    }
  }
  return [...forms];
}

/**
 * The first readable form of any of `secrets` found in a forwarded payload —
 * its bytes read as Latin-1, so a UTF-8 marker matches wherever its bytes
 * are — or null if there is none.
 */
export function findReadable(
  payloads: ForwardedPayload[],
  secrets: string[],
): { secret: string; form: string; payload: ForwardedPayload } | null {
  const needles = secrets.flatMap((secret) =>
    readableForms(secret).map((form) => ({ secret, form })),
  );
  for (const payload of payloads) {
    const asText = payload.bytes.toString("latin1");
    for (const { secret, form } of needles) {
      if (asText.includes(form)) {
        return { secret, form, payload };
      }
    }
  }
  return null;
}
