// Uploads dist-relay-web/<version>/** to the relay's R2 bucket at
// app/<version>/<path> (ADR-206 D4). `--local` writes to the miniflare store
// `pnpm relay:dev` reads; `--remote` (default) writes to Cloudflare.
//
// Each file is its own `wrangler r2 object put` (wrangler has no bulk upload
// and no object listing), and a wrangler process costs ~1.2s just to start,
// so remote puts run CONCURRENCY at a time rather than one after another.
//
// Files under assets/ are named by their content hash, so one the relay
// already serves for this version is byte-for-byte the same and is skipped:
// a HEAD against the relay itself (`--relay <url>`, defaulting to the
// production relay or, with --local, `pnpm relay:dev`'s) says which are
// there. Everything else — web.html, sw.js, the manifest, icons, fonts — has a
// stable name and can change within a version while iterating, so it is
// always uploaded. `--force` uploads everything.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// `wrangler dev` binds WEB to `preview_bucket_name` locally, so that is the
// bucket a local upload has to land in for `pnpm relay:dev` to serve it.
const local = process.argv.includes("--local");
const BUCKET = local ? "manor-relay-web-dev" : "manor-relay-web";
const PERSIST = ".wrangler/state"; // relay/-relative; same as relay:dev
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
const dir = path.join(root, "dist-relay-web", version);

function* walk(d) {
  for (const name of readdirSync(d)) {
    const full = path.join(d, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const force = process.argv.includes("--force");
const relayArg = process.argv.indexOf("--relay");
const RELAY =
  relayArg !== -1
    ? process.argv[relayArg + 1]
    : local
      ? "http://127.0.0.1:8787"
      : "https://relay.manor.sh";
// The local store is Miniflare's SQLite: concurrent writers get R2 500s, so
// a local upload stays serial and leans on the skip above instead.
const CONCURRENCY = local ? 1 : 8;

/** Whether the relay already serves this version's `rel`. Unknown is no. */
async function published(rel) {
  try {
    const res = await fetch(`${RELAY}/app/${version}/${rel}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function put(file, key) {
  const args = [
    "--filter",
    "manor-relay",
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `${BUCKET}/${key}`,
    "--file",
    file,
    ...(TYPES[path.extname(file)]
      ? ["--content-type", TYPES[path.extname(file)]]
      : []),
    ...(local ? ["--local", "--persist-to", PERSIST] : ["--remote"]),
  ];
  return new Promise((resolve) => {
    const child = spawn("pnpm", args, {
      // Output only on failure: eight interleaved wrangler logs are noise.
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output }));
  });
}

const files = [...walk(dir)].map((file) => ({
  file,
  rel: path.relative(dir, file).split(path.sep).join("/"),
}));

const skipped = new Set();
if (!force) {
  const hashed = files.filter(({ rel }) => rel.startsWith("assets/"));
  const there = await Promise.all(hashed.map(({ rel }) => published(rel)));
  hashed.forEach(({ rel }, i) => there[i] && skipped.add(rel));
}
const queue = files.filter(({ rel }) => !skipped.has(rel));

let done = 0;
let failed = false;
async function worker() {
  while (queue.length > 0 && !failed) {
    const { file, rel } = queue.shift();
    const key = `app/${version}/${rel}`;
    const { code, output } = await put(file, key);
    if (code !== 0) {
      failed = true;
      process.stderr.write(output);
      console.error(`upload failed: ${key}`);
      return;
    }
    done++;
    console.log(`  ${rel}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (failed) process.exit(1);
console.log(
  `uploaded ${done} files for ${version}` +
    (skipped.size ? `, skipped ${skipped.size} already on ${RELAY}` : ""),
);
