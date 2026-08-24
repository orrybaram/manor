---
title: Remote bootstrap — detect, install, and version-match manor-host
status: todo
priority: high
assignee: opus
blocked_by: [4]
---

# Remote bootstrap — detect, install, and version-match manor-host

Before `SshTransport` can bridge, the remote box needs a `manor-host` matching this
app's version. Implement `electron/backend/remote-bootstrap.ts`.

Unlike herdr we cannot ship one static binary: the daemon depends on `node-pty`, a
native addon. v1 therefore **requires Node ≥ 20 on the remote host** and lets npm resolve
node-pty's platform prebuilds.

`ensureRemoteHost(target, appVersion, ssh): Promise<{ installed: boolean; version: string }>`:

1. **Detect** — `ssh <target> 'uname -sm'`; accept `Linux`/`Darwin` × `x86_64|amd64|aarch64|arm64`.
   Anything else throws a clear "remote platform not supported" error.
2. **Check Node** — `node --version` on the remote; require ≥ 20, with an actionable error
   naming the requirement if absent or older.
3. **Check existing** — `"$HOME/.manor/bin/manor-host" --version` (ticket 4). If it equals
   `appVersion`, return early.
4. **Install** — stream a version-pinned tarball built from `electron/terminal-host/`
   over ssh stdin into `$HOME/.manor/host/.tmp.$$`, run `npm install --omit=dev
   --no-audit --no-fund` there, then atomically rename to `$HOME/.manor/host` and write a
   `$HOME/.manor/bin/manor-host` launcher shim (`exec node "$HOME/.manor/host/index.js"
   "$@"`, mode 0755). Follow herdr's prepare → stream → commit split so a failed transfer
   never replaces a working install.

Add a build script `scripts/build-host-tarball.mjs` producing
`dist-electron/manor-host-<version>.tgz` from the daemon bundle plus a generated
`package.json` pinning `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, and
`tree-kill` at the versions in the root `package.json`. Wire it into the `package`
script in `package.json`.

Report progress through a callback so the UI (ticket 11) can show "installing Manor host
on <target>…".

## Files to touch
- `electron/backend/remote-bootstrap.ts` — new; detect/check/install.
- `scripts/build-host-tarball.mjs` — new; tarball builder.
- `package.json` — run the tarball build as part of `package`.
- `electron/backend/__tests__/remote-bootstrap.test.ts` — new; fake ssh runner, assert
  the command sequence, the early-return on version match, and that a failed transfer
  does not commit.
