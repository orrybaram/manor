---
title: Per-version web builds served from R2
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Per-version web builds served from R2

ADR-206 D4. Every release uploads its web app build so relay devices on that
version load a matching renderer.

## What to build

- **`vite.web.config.ts`:** `base` from `process.env.MANOR_WEB_BASE ?? "/app/"`;
  `outDir` from `MANOR_WEB_OUT_DIR ?? dist-electron/web`. Listener build
  unchanged. Add `pnpm build:web:relay` that builds with
  `MANOR_WEB_BASE=/app/<pkg.version>/` into `dist-relay-web/<version>/`.
- **Worker (`relay/src/index.ts`):** `GET /app/:version/*` serves from R2
  binding `WEB` key `app/<version>/<path>` (`web.html` for the bare version
  path). Same headers as `electron/remote-control/static.ts` (`WEB_CSP`,
  `no-referrer`, `nosniff`, `no-store` for html/sw, immutable for hashed
  assets) — import `WEB_CSP` rather than copy it. Missing version → a small
  static HTML page: "This Manor version's web app isn't published. Update
  Manor, or use Tailscale." Missing file → 404.
- **Release workflow (`.github/workflows/release.yml`):** after the build,
  run `build:web:relay` and `wrangler r2 object put` (or `rclone`/S3 API) each
  file to `app/<version>/…`, then `wrangler deploy` the Worker. Secrets:
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; skip with a warning when
  absent so forks still release.
- **Dev:** `relay:dev` uses a local R2 bucket; a `relay:dev:upload` script
  writes the local `build:web:relay` output into it.

## Tests

Worker tests: serves html with CSP, serves an asset with immutable cache,
missing version page, traversal (`/app/1.0.0/../x`) rejected.

## Files to touch
- `vite.web.config.ts`, `package.json`
- `relay/src/index.ts`, `relay/wrangler.toml`, `relay/test/*`
- `.github/workflows/release.yml`
