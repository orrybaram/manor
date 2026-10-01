---
title: Build the renderer as a browser bundle and serve it at /app
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Build the renderer as a browser bundle and serve it at /app

ADR-178 D1. The desktop renderer, built a second time for a browser, served
unauthenticated as an app shell by the remote listener — the same trade
`static.ts` already documents for the remote client.

## Entry

- `src/web-main.tsx` — a sibling of `src/main.tsx`. Same `QueryClient`, same
  `loadTerminalFonts()`, same `<App />`. Before anything renders:
  1. read the token from `location.hash` (copy `readToken`/`forgetToken` from
     `src/remote-client/main.ts` — the remote client is a separate bundle and
     cannot be imported; keep the "store then strip from the address bar"
     behaviour and the `localStorage` key distinct from the remote client's);
  2. `window.electronAPI = createWsBridge({ token })` (ticket 4; until it
     exists, install a stub that rejects everything so this ticket builds
     alone);
  3. if there is no token, render a one-line "open the link from the pairing
     dialog" screen instead of `App`.
- `src/web.html` — copy of `index.html` pointing at `/src/web-main.tsx`. Its
  meta CSP is redundant with the served header but keep it identical to
  `static.ts`'s.

## Build

- `vite.web.config.ts` — modelled on `vite.remote.config.ts`: `root: "src"`,
  `base: "./"`, `plugins: [react()]`, input `src/web.html`, `outDir:
  dist-electron/web`, `define: __APP_VERSION__`. No `vite-plugin-electron`.
  Check what `import.meta.env`/`process` references the renderer makes that
  only resolve under `vite-plugin-electron-renderer` and shim them.
- `package.json` — `build` and `dev` run this config too; add `build:web`.
- `knip.json` — register the new entry.

## Serve

- `electron/remote-control/static.ts` — a second client directory
  (`defaultWebDir()` → `dist-electron/web`); requests under `/app` serve from
  it with the same traversal guard and cache headers. The CSP for `/app`
  matches `index.html`'s desktop policy plus what the bundle needs in a browser:
  `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self' 'unsafe-inline'`,
  `connect-src 'self'` (covers same-origin `ws:`/`wss:` under CSP3 — verify in
  Chrome and Safari; add `ws:`/`wss:` explicitly if either refuses),
  `font-src 'self'`, `img-src 'self' data:`, `worker-src 'self'`. Keep the
  remote client's stricter CSP for `/`.
- `electron/remote-control/server.ts` — route `/app` and `/app/*` to the new
  directory *before* auth, exactly where `/` is routed today.

## Verify

`pnpm build` produces `dist-electron/web/`; with remote control enabled,
`curl http://127.0.0.1:<port>/app` returns the shell with the CSP header; a
browser at `/app` with no token shows the "open the link" screen.

## Files to touch
- `src/web-main.tsx`, `src/web.html` — new entry
- `vite.web.config.ts` — new build config
- `package.json`, `knip.json` — scripts and entry registration
- `electron/remote-control/static.ts` — second directory, `/app` CSP
- `electron/remote-control/server.ts` — serve `/app` before auth
