---
title: E2E — prove the desktop is still the desktop
status: in-progress
priority: high
assignee: opus
blocked_by: [12, 15]
---

# E2E — prove the desktop is still the desktop

> **Scope, after the split.** This ticket is the E2E half: the four new
> scenarios, the stale specs, the `markSeen` investigation, the flake. The
> **Docs** section below and every docs item in the "Folded in" sections
> (`AGENT-SYSTEM.md`, the ADR-178 amendment, D8's preload claim,
> `CONTEXT.md`, the transport header) moved to **ticket 16**. Leave them.

ADR-180's closing ticket: prove the desktop still is the desktop, and write
down what changed for the people who read the docs instead of the diff.

## E2E

The existing desktop suite is the real assertion here — every spec in
`tests/e2e/` now exercises the bridge, because there is no other path. Run it
unattended (see `1f2fa68`). Beyond that, add to `tests/e2e/web-app.spec.ts` or
a sibling:

- **A desktop window and a browser on one pane.** The desktop owns the
  winsize; the browser follows; close the desktop tab and the browser is told
  it now owns it (`pty.winsizeOwner`), which ADR-179 D6 built and this slice
  makes reachable from the desktop side too.
- **Two desktop windows on one pane** (the primary and a detached window
  claiming the tab): the more recent attach owns the winsize and the other
  follows, rather than the two fighting. This is D6's repair and it has no
  test today.
- **A `full` device is refused a `LOCAL_ONLY` method.** `remoteControl.pair`
  over the bridge comes back `unavailable:web` and leaves the device list
  unchanged.
- **The CLI with the window closed.** `manor split-pane` and a `menu-command`
  still land, which is ticket 4's addressed-event path.

## Docs

- `docs/remote-control.md` — the `full` tier section gains `LOCAL_ONLY`: name
  the five `remoteControl` methods and the keybinding writes a paired device
  cannot reach, and say why (a token that can pair survives its own
  revocation). Keep the doc's habit of stating what is absent rather than
  implying it.
- `docs/agents/domain.md` — the bridge is no longer "IPC inside Electron,
  HTTP/WebSocket from a browser, converging on the latter"; it is one table
  with two transports.
- `CONTEXT.md` — **Bridge** is reworded to match; add **Host surface** (the
  handler table: the one set of things a renderer can ask a host to do),
  **Transport** (how frames get there — Electron IPC or a WebSocket — never a
  place where behaviour lives) and **Caller class** (`local` or `device`).
  Keep the `_Avoid_` lines in the file's existing style.
- `docs/decisions/adr-178-web-app-and-single-bridge/index.md` — amend D8 and
  its Consequences: the desktop does not dial a loopback socket; the recorded
  "first paint will one day wait on a localhost socket" is superseded by
  ADR-180 D2. Link ADR-180 from D10's slice list as slice 3, the way slice 2
  links ADR-179.

## Files to touch
- `tests/e2e/web-app.spec.ts` — the four scenarios above (or a new `bridge.spec.ts`)
- `docs/remote-control.md` — the `LOCAL_ONLY` paragraph
- `docs/agents/domain.md` — the bridge's new shape
- `CONTEXT.md` — Bridge reworded; Host surface, Transport, Caller class added
- `docs/decisions/adr-178-web-app-and-single-bridge/index.md` — D8/D10 amendment

## Folded in from ticket 4

A pre-existing flake to kill while you are in the tests:
`src/store/__tests__/agent-status-store.test.ts` → "deduplicates: same
status+kind produces no state update" fails when two `Date.now()` calls
straddle a millisecond boundary, because the store's dedupe compares `since`.
`vi.useFakeTimers()` or a fixed `since` in the fixture. Unrelated to ADR-180,
but it will be blamed on it the first time it fails in CI.

## Folded in from ticket 5

**Three E2E specs fail on a clean tree, all pre-existing.** Ticket 5 confirmed
each against a rebuilt baseline — none is ADR-180's doing, and all three will
be blamed on it otherwise:

- `tests/e2e/claude-resize-duplication.spec.ts` — the real `claude` CLI's
  trust prompt now defaults to "❯ No, exit", so the spec's `Enter` exits
  Claude instead of accepting, and the comment saying "the default choice is
  the one we want" is stale. This is the **only** guard on resize duplication
  with a real agent (ADR-163/164/165's bug) and it has been failing silently;
  fix it first.
- `tests/e2e/command-palette-frequent.spec.ts` — the "Frequently Used" group
  is still rendered while filtering.
- `tests/e2e/read-state.spec.ts:139` — the sidebar agent dot never appears.

**`docs/AGENT-SYSTEM.md:290` is now partly stale.** Ticket 5 found that
`PtyBackend.createOrAttach` had no `env` parameter while `ipc/pty.ts` passed
one, so `MANOR_AGENT_KIND` was silently dropped between them — ADR-135 ticket
7's intent, unrealised. Threading `env` through is what made
`electron/ipc/pty.ts:127` compile, so agent hooks for codex and pi panes now
report their real kind instead of defaulting to `claude`. The doc still lists
that as an open flaw.

## Folded in from ticket 6

Two more stale specs, both verified against a stashed and rebuilt clean tree,
bringing the pre-existing total to five:

- `tests/e2e/sidebar-pr-tweaks.spec.ts:197` — a PR popover expects 4 comment
  authors and gets 0.
- `tests/e2e/pr-badge-matrix.spec.ts:208` — `lucide-shield-question` vs
  `lucide-shield-question-mark`, a lucide rename.

Also worth a line in the E2E README: ticket 6 shipped a bug that typecheck and
2968 unit tests were all green for — `layout.reportViewport` stripped `claim`
from every caller, so detach-to-window silently stopped working — and
`detach.spec.ts` was the only thing that caught it. That is the argument for
running the suite on every crossing, and it should be written down where the
next person will look.

## Folded in from ticket 12

- **`web-app.spec.ts:146` still fails, and it is a real question, not a stale
  assertion.** Its cause changed once `4df4609` took `agents.reconcileStale`
  out of `MUTATING`: it now fails on `expect(audit).toContain("agents.markSeen")`
  receiving `["pty.create", "agents.setPaneContext"]`. Ticket 12 confirmed the
  identical failure at HEAD in a detached worktree, so it predates that ticket.
  **The browser never calls `agents.markSeen`.** ADR-179 ticket 4 made visible
  agents get marked seen when the viewport changes; find out whether that flow
  reaches a browser at all. Fix the flow if it is broken, and only widen the
  spec if the browser genuinely should not be marking agents seen — in which
  case say why, because "check on my agents from anywhere" is the sentence
  ADR-178 started from.
- **`src/bridge/transports/ipc.ts`'s header is stale** the way `handlers.ts`'s
  was: it still says `native` is "still *every* namespace" and describes the
  later tickets as future work. Correct it to the final state.
- **`electron/preload.ts` is 480 lines, not the "well under 300" D8 claimed.**
  Correct D8 rather than the code: `webview`'s 27 methods are ~250 lines on
  their own, and splitting `preload.ts` is a different change from this one.

## Folded in from ticket 15

**The gate changed; say so in the docs.** `pnpm build` now runs `pnpm
typecheck` (both tsconfigs, zero baseline) before Vite, so a green build is a
build in which D7's surface check ran. Before ticket 15 nothing in the repo
ran `tsc`. `tests/e2e/README.md`, and wherever the repo tells a contributor how
to check their work, should name `pnpm typecheck` and say that adding an
`ElectronAPI` method without placing it fails the build by name.

Note for the E2E run: ticket 15's agent stalled after its build went green and
before it ran E2E. The orchestrator finished the unit, lint and typecheck runs
and verified the gate by planting `stats.frobnicate`, but **E2E was not run
after `4ebaeac`.** Ticket 15's runtime change is small — a dead parameter
removed from `sendAgentUpdate` and `handleStreamEvent` — but it is on the
agent-update path, so run `agent-rename.spec.ts` and `read-state.spec.ts`
with that in mind.

## The `markSeen` investigation: settled (orchestrator, `81c103b`)

**The app was right and the spec was stale, and the failure read backwards.**

`web-app.spec.ts` asserted `expect([...allowed]).toContain(entry.route)` —
the *received array* is the allowlist and the *expected value* is the actual
route. So a failure reading `Expected value: "agents.markSeen" / Received
array: ["pty.create", "agents.setPaneContext"]` means an audit line for
`agents.markSeen` **was written**: the browser called it. Ticket 12 read it
as the browser never calling it, and the orchestrator repeated that; both
were wrong.

What actually happens: `markVisibleAgentsSeen` fires on every viewport change
(ADR-179 ticket 4), ticket 9 put `agents.markSeen` on the table and in
`MUTATING`, so a browser marking a visible agent seen now leaves an audit
line the spec's two-route allowlist rejected. Whether the line appears at all
depends on whether the desktop cleared the flag first — the unseen sets live
on the Manor server — so the spec now allows the route rather than requiring
it, and exempts it from the pane-id target check, because `bridgeTarget`
records the first string argument and for `markSeen` that is an agent id.

**Nothing further is owed on this item.** It is fixed and committed. Do not
re-investigate it; the remaining work in this ticket is the four new
scenarios, the four other stale specs, and a green unattended run.

## The five stale specs: settled

| spec | verdict | where |
| --- | --- | --- |
| `command-palette-frequent` | spec stale — the palette started keeping matching frequent commands pinned while searching (`8b18cee`) and lifting them out of their home groups | `a9d10b9` |
| `pr-badge-matrix` | fixture stale — lucide renamed `shield-question` to `shield-question-mark` and left the old module as a re-export, so the app kept compiling | `a9d10b9` |
| `sidebar-pr-tweaks` | spec stale, and **it was asserting nothing**: the comment card moved to `ui/PrCommentCard` (`bf77ca65`) and took its class names with it, so four comment authors read as zero and every assertion below passed vacuously. `PrCommentCard` now carries test ids | `a9d10b9` |
| `claude-resize-duplication` | spec stale, twice over — see below | `d922ad6` |
| `read-state.spec.ts:139` | **passes with no change.** Something between its last failure and now fixed it; `test-results/.last-run.json` reports `passed`. Not claimed as a fix by any ticket — watch it in the full run rather than assuming | — |

**The resize guard had stopped guarding.** `claude-resize-duplication` is the
only spec that drives the real `claude` at the ADR-163/164/165 bug, and it had
been failing long enough to be carried as a known failure through this whole
ADR. Two independent layers of staleness, each costing 120 seconds of silence:
the trust prompt inverted (`❯ No, exit` is now the default, so the bare
`Enter` quit Claude), and `Welcome back` turns out to print only on a *resumed*
session. Both fixed; it passes in 39s and reproduces what it is for —
`printed 198/198, duplicated 0 before the resize and 17 after`, under the
ceiling `helpers/zq-run` documents as the emulator's floor rather than
manor's.

The lesson worth keeping: three of these five were specs that had quietly
stopped testing their subject, and two of them (`sidebar-pr-tweaks`,
`claude-resize-duplication`) were *green-adjacent* failures nobody read. A
known-failure list is a place tests go to die.
