---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-054: Portless Named Previews

## Context

Manor detects local dev server ports via `lsof` scanning (`electron/ports.ts`) and opens them in browser panes as raw `http://localhost:{port}` URLs. This has several problems:

1. **Ports are meaningless** — `localhost:3000` tells you nothing about which project it belongs to. Users with multiple workspaces running dev servers must remember which port maps to which project.
2. **Port instability** — ports change across restarts, so bookmarks, cookies, and localStorage are lost.
3. **Cookie/storage collisions** — all `localhost` ports share the same origin for cookies, leading to cross-project interference.
4. **No identity** — browser pane tab titles show "localhost:3000" instead of the project name.

[Vercel's portless library](https://github.com/vercel-labs/portless) solves this by mapping dev servers to stable named `.localhost` URLs (e.g., `http://myapp.localhost`). It provides a lightweight Node.js proxy (~280 lines) that routes requests by `Host` header to the correct backend port. Chromium (and therefore Electron's webviews) resolves `*.localhost` to `127.0.0.1` per RFC 6761, so no DNS server or `/etc/hosts` hacking is needed.

Manor already has all the pieces: port scanning, workspace metadata (project names, branches), and browser panes. We just need to connect them through a proxy.

## Decision

**Add `portless` as a dependency and embed its proxy in Electron's main process**, mapping Manor's scanned ports to named `.localhost` URLs derived from workspace metadata.

### Architecture

```
PortScanner detects port 3000 (workspace: ~/Code/myapp)
    -> PortlessManager.updateRoutes()
    -> Route: myapp.localhost -> 127.0.0.1:3000
    -> BrowserPane loads http://myapp.localhost
    -> Proxy (port 1355) routes Host:myapp.localhost -> localhost:3000
```

### New: `electron/portless.ts` — PortlessManager

A new class that owns the portless proxy lifecycle and route computation:

- **`start()`** — calls `createProxyServer({ proxyPort, getRoutes })` from the portless library. The proxy is a plain `net.Server` running in-process (not a child process).
- **`stop()`** — closes the proxy server on app quit.
- **`updateFromScannedPorts(ports, workspaces)`** — called whenever `PortScanner` emits new ports. Computes named routes from workspace metadata and updates the internal route table. The portless proxy calls `getRoutes()` on every incoming request, so no reload is needed.
- **`hostnameForPort(port, workspaces)`** — derives the `.localhost` hostname:
  - Base name from the project's `name` field in `package.json`, or the workspace directory basename, sanitized to a valid DNS label.
  - If the workspace is on a non-main branch, prefix with the branch name: `feature-x.myapp.localhost`.
  - All names are lowercased, non-alphanumeric chars replaced with hyphens, max 63 chars per label.

### Modified: `electron/ports.ts` — ActivePort gains `hostname`

```typescript
interface ActivePort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
  hostname: string | null;  // NEW — e.g. "myapp.localhost"
}
```

After `PortScanner.scan()` resolves workspace paths, `PortlessManager` enriches each port with its computed hostname before the result is sent to the renderer via IPC.

### Modified: `src/components/PortBadge.tsx` — use named URL

```typescript
// Before
const url = `http://localhost:${port.port}`;

// After
const url = port.hostname
  ? `http://${port.hostname}`
  : `http://localhost:${port.port}`;
```

The badge display also updates to show the hostname when available (e.g., "myapp" instead of "3000"), with the port number as secondary info.

### Modified: `electron/main.ts` — lifecycle wiring

- Instantiate `PortlessManager` alongside `PortScanner`.
- After port scan completes, pass results through `PortlessManager.updateFromScannedPorts()` before emitting `ports-changed`.
- Start proxy on app ready, stop on app quit.

### What we use from portless (the dependency)

- `createProxyServer()` — the HTTP/WS proxy that routes by `Host` header. Handles HTTP/1.1, WebSocket upgrades (critical for HMR), `X-Forwarded-*` headers, and loop detection.
- `RouteInfo` type — the `{ hostname, port }` shape the proxy expects.

### What we DON'T use from portless

| Feature | Why skip |
|---------|----------|
| TLS / cert generation | `certs.ts` isn't in the public API; HTTP is fine for local dev in our own webviews |
| `/etc/hosts` management | Only needed for Safari; Electron webviews are Chromium |
| Route persistence (JSON) | Routes are ephemeral, derived from live port scans — no need to persist |
| CLI / framework flag injection | Manor discovers ports, it doesn't spawn dev servers |
| Auto-naming from `package.json` | We already have project names in the workspace store |

### Proxy port selection

Default to port 1355 (portless convention). If unavailable, pick a random free port. Write the chosen port to `~/.manor/portless-proxy-port` so external tools (like the MCP webview server) can discover it.

### No HTTPS (for now)

The portless library's cert generation (`certs.ts`) is not part of its public API. For the initial implementation, HTTP-only is sufficient — our webviews don't need TLS for local dev. HTTPS can be added later by bringing our own cert generation if needed.

## Consequences

**Better:**
- Preview tabs show meaningful names (`myapp.localhost`) instead of port numbers
- Each named preview gets its own browser origin — no cookie/storage collisions
- Stable URLs survive port changes across dev server restarts
- Branch-prefixed URLs (`feature.myapp.localhost`) make it obvious which branch you're previewing
- HMR/WebSocket connections work transparently through the proxy

**Harder:**
- New dependency (`portless`) — though it only depends on `chalk` and uses Node built-ins
- Proxy adds one network hop (localhost -> localhost), negligible latency but adds a failure point
- Port 1355 could conflict with other portless installations or local services
- Users running portless CLI separately would see route conflicts — we should detect and skip if an external portless proxy is already running

**Risks:**
- portless is a Vercel Labs project (0.7.x) — not yet 1.0, API could change. Mitigated by the fact that our integration surface is tiny (`createProxyServer` + `RouteInfo`).
- If the proxy crashes, named previews stop working — fallback to direct `localhost:{port}` URLs should be automatic.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
