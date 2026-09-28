---
title: Ship manor-cli.js in the host package and install a manor shim
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Ship manor-cli.js in the host package and install a manor shim

See ADR-189 §4.

- `scripts/build-host-tarball.mjs`: add `manor-cli.js` (built by Vite from `electron/manor-cli.ts` into `dist-electron/`) to the bundle list. The existing "no electron require" guard must pass. If it fails, fix the import in the CLI, not the guard.
- `electron/backend/remote-bootstrap.ts`: in the commit step that writes `~/.manor/bin/manor-host`, also write `~/.manor/bin/manor`:
  - a `#!/bin/sh` shim running `exec <pinned node path> "$HOME/.manor/host/manor-cli.js" "$@"`;
  - built by a new `renderCliShim(nodePath)` next to `renderLauncherShim`, written atomically the same way (tmp + mv, chmod +x);
  - update the layout doc comment at the top of the file.
- Tests: extend the existing remote-bootstrap tests (the commit command contains the new shim and `renderCliShim` output), and the tarball test if one exists.

## Files to touch
- `scripts/build-host-tarball.mjs` — bundle list
- `electron/backend/remote-bootstrap.ts` — `renderCliShim`, commit step, layout comment
- matching `*.test.ts` files
