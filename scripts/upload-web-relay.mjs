// Uploads dist-relay-web/<version>/** to the relay's R2 bucket at
// app/<version>/<path> (ADR-206 D4). `--local` writes to the miniflare store
// `pnpm relay:dev` reads; `--remote` (default) writes to Cloudflare.
import { spawnSync } from "node:child_process";
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

let count = 0;
for (const file of walk(dir)) {
  const key = `app/${version}/${path.relative(dir, file).split(path.sep).join("/")}`;
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
  const r = spawnSync("pnpm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`upload failed: ${key}`);
    process.exit(r.status ?? 1);
  }
  count++;
}
console.log(`uploaded ${count} files for ${version}`);
