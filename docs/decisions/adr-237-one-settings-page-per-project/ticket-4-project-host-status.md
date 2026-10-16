---
title: projectHostStatus helper and its test
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# projectHostStatus helper and its test

ADR-237 D3. A project's host row shows one status word and a tone. Keep
that decision in a pure function so it is tested once.

Create `src/components/settings/ProjectHostsSection/project-host-status.ts`:

```ts
import type { HostDisplay, HostTone } from "../../../lib/host-status";
import { pendingDisplay } from "../../../lib/host-status";
import { isRemoteHost } from "../../../lib/hosts";

export type ProjectHostStatus = { word: string; tone: HostTone | null };

/**
 * The one word a project's host row shows beside its name (ADR-237 D3):
 * "Local" for this machine, in no tone; a remote host's `status` in its
 * tone, falling back to the pending display before the host has reported.
 */
export function projectHostStatus(
  hostId: string,
  display: HostDisplay | undefined,
): ProjectHostStatus {
  if (!isRemoteHost(hostId)) return { word: "Local", tone: null };
  const shown = display ?? pendingDisplay(hostId);
  return { word: shown.status, tone: shown.tone };
}
```

Check `isRemoteHost`'s signature in `src/lib/hosts.ts` and `pendingDisplay`
in `src/lib/host-status.ts` (what `status` and `tone` it returns for an
unreported host) and match them; the test's expected values come from
those, not from this ticket's guesses.

Create `project-host-status.test.ts` beside it (vitest, see any
`*.test.ts` under `src/lib/` for the import style):

- `"local"` → `{ word: "Local", tone: null }`.
- a remote id with a display `{ status: "Connected", tone: "ok", … }` →
  `{ word: "Connected", tone: "ok" }` (build the display with a cast or a
  minimal object; see how `HostDisplay` is built in `host-status.test.ts`
  if one exists).
- a remote id with `undefined` → the `status` and `tone` that
  `pendingDisplay(id)` returns.

## Files to touch
- `src/components/settings/ProjectHostsSection/project-host-status.ts` — new
- `src/components/settings/ProjectHostsSection/project-host-status.test.ts` — new

## Acceptance
- `pnpm typecheck` and `pnpm test:unit` pass.
