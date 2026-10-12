---
title: Ship the host server in the tarball and keep it running
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Ship the host server in the tarball and keep it running

ADR-218 D1 (lifecycle).

- `scripts/build-host-tarball.mjs`:
  - Bundle `electron/host-server/index.ts` as `host-server-index.js`. The existing no-`electron` check must cover it.
  - Add `ws` and `web-push` to the generated `package.json`. Check the `@noble/*` packages get bundled.
- `manor-host serve` dispatches to the host server. `manor-host remote-bridge` and `server-bridge` call `ensureServerRunning()` (detached, unref'd, as `transport-local.ts:229-238` does for the daemon) before piping.
- Version handling: if `dataDir/server.version` differs from the tarball version, SIGTERM the old server, wait, and start the new one. Never touch the daemon on a server upgrade.
- `remote-bootstrap.ts`: no change beyond the new files, if the shims already route `manor-host <subcommand>`; verify that.
- Unit test: `ensureServerRunning` starts once, is idempotent, and replaces a server whose version is stale.

## Files to touch
- `scripts/build-host-tarball.mjs`
- `electron/terminal-host/index.ts`
- `electron/host-server/lifecycle.ts` (new)
- `electron/backend/remote-bootstrap.ts` (only if needed)
