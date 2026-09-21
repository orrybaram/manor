---
title: Docs and the vocabulary
status: done
priority: high
assignee: sonnet
blocked_by: [13]
---

# Docs and the vocabulary

ADR-180's closing ticket, split out of ticket 13 once that one grew an
investigation. Write down what changed for the people who read the docs
instead of the diff. Every item below was either in ticket 13's original
**Docs** section or folded into it by a later ticket; it is gathered here so
nothing is left in a section somebody was told to skip.

Read `docs/decisions/adr-180-one-host-surface/index.md` and every ticket file
in that folder first — the tickets' "Folded in" sections are where the real
story of this ADR is, and several of them correct the index.

## The domain docs

- **`CONTEXT.md`** — reword **Bridge**: it is no longer "implemented over IPC
  inside Electron today and over HTTP/WebSocket from a browser, converging on
  the latter"; it is one table with two transports. Add **Host surface** (the
  handler table — the one set of things a renderer can ask a host to do),
  **Transport** (how frames get there, Electron IPC or a WebSocket — never a
  place where behaviour lives) and **Caller class** (`local` or `device`).
  Match the file's existing `_Avoid_:` style.
- **`docs/agents/domain.md`** — the bridge's new shape, same correction.
- **`docs/remote-control.md`** — the `full` tier section gains `LOCAL_ONLY`.
  Name what a paired device cannot reach — the keybinding writes, the five
  `remoteControl` pairing methods, `linear.connect`, the viewport and prewarm
  pairs, `appCommands.result` — and say why for the pairing ones: a token that
  can pair more devices survives its own revocation. Keep the doc's habit of
  stating what is absent rather than implying it.
- **`docs/AGENT-SYSTEM.md:290`** — still lists `MANOR_AGENT_KIND` not reaching
  the spawn env as an open flaw. Ticket 5 fixed it (`PtyBackend.createOrAttach`
  had no `env` parameter, so it was dropped between the IPC handler and the
  daemon client). Codex and pi panes now report their real kind.

## The headers

- **`src/bridge/transports/ipc.ts`** — still says `native` is "still *every*
  namespace" and describes tickets 5–10 as future work. Correct it to the
  final state.

## The contributor-facing gate

- Wherever the repo tells a contributor how to check their work, and
  `tests/e2e/README.md` in particular: **`pnpm build` runs `pnpm typecheck`
  first** (ticket 15), both tsconfigs, zero baseline, and adding an
  `ElectronAPI` method without placing it fails the build by name. Say what
  "placing" means: `HANDLERS`, `nativeApi`, `LOCALLY_SERVED` or
  `SUBSCRIPTIONS` (ticket 12 added the fourth).

## The records

- **`docs/decisions/adr-178-web-app-and-single-bridge/index.md`** — amend D8
  and its Consequences: the desktop does not dial a loopback socket; the
  recorded "first paint will one day wait on a localhost socket" is superseded
  by ADR-180 D2. Link ADR-180 from D10's slice list as slice 3, the way slice 2
  already links ADR-179.
- **`docs/decisions/adr-180-one-host-surface/index.md`** — this ADR's own
  claims have to match what shipped. At minimum:
  - D8 says `preload.ts` "goes from 941 lines to the native namespaces plus
    `invoke`/`subscribe`" and ticket 11 was asked for "well under 300". It is
    480. `webview`'s 27 methods are ~250 on their own; splitting the file is a
    different change. Say so.
  - D7 names three placement sets. Ticket 12 found 25 unplaced methods — every
    non-native subscription — and added a fourth, `SUBSCRIPTIONS`. D7 should
    say four, and why.
  - D7 promises a compile-time check. Until ticket 15, nothing ran `tsc`.
    Record that the check is real *because* of ticket 15.
  - D4's `LOCAL_ONLY` list grew during implementation (`linear.connect`,
    `appCommands.result`, the viewport and prewarm pairs). Make the list in
    the index the list in the code.
  - Add a short **"What implementation found"** section to Consequences with
    the three latent bugs this ADR surfaced that were not its subject:
    `MANOR_AGENT_KIND` silently dropped since ADR-135 (ticket 5), the web
    app's stores never initialising against the bridge since ADR-178 slice 1
    (ticket 14), and whatever ticket 13's `markSeen` investigation concludes.
    Plus the one it nearly shipped: `layout.reportViewport` stripping `claim`
    from desktop windows, caught only by `detach.spec.ts` (ticket 6).
  - Flip `status: proposed` → `accepted` **only** after the orchestrator's
    integration verification passes. Leave it `proposed` in your commit;
    the orchestrator flips it.

## Files to touch
- `CONTEXT.md`
- `docs/agents/domain.md`
- `docs/remote-control.md`
- `docs/AGENT-SYSTEM.md`
- `src/bridge/transports/ipc.ts` — header only
- `tests/e2e/README.md`
- `docs/decisions/adr-178-web-app-and-single-bridge/index.md`
- `docs/decisions/adr-180-one-host-surface/index.md` — **this agent may edit it**; the usual "orchestrator owns `docs/decisions/`" rule is lifted for this ticket's two files, and only those two

## Added after ticket 13 closed — read ticket 13's file in full

Ticket 13 grew well past its brief. Its file is the primary source for the
items below; read it, including its **Correction** section, before writing.

**"What implementation found" must list these real bugs**, each with its
commit — they are the strongest argument in the record for this ADR's
approach, and none was its subject:

| bug | since | fixed |
| --- | --- | --- |
| `MANOR_AGENT_KIND` silently dropped between IPC handler and daemon client | ADR-135 | `d04d8ed` (ticket 5) |
| web app's stores never initialised against the bridge | ADR-178 slice 1 | `07c8d67` (ticket 14) |
| `layout.reportViewport` stripped `claim` from desktop windows — detach broke | ADR-180 ticket 6, caught before shipping | ticket 6 |
| **one viewer's `pty.detach` froze every other viewer's terminal** | ADR-178 slice 1 | `23023f0` |
| **a stolen token trying to pair left no audit line** | ADR-178 slice 1 | `6bd3a3d` |
| …and that fix made every browser mount write a `rejected` line | this ADR | `e89c96c` |

**And the tests that had stopped testing their subject** — five "known
failures" carried through this ADR, of which three were asserting nothing:
`sidebar-pr-tweaks` (four authors read as zero, every assertion vacuous),
`claude-resize-duplication` (the only real-agent guard on ADR-163/164/165,
disabled by an inverted trust prompt), and `read-state:139` (stale since
ADR-167). Plus `app-menu:75`, which raced Electron's default menu. Say plainly
that a known-failure list is where tests go to die; it is the most
transferable lesson this ADR produced.

**Record the discarded hypothesis and the open question** from ticket 13's
Correction section, under "Not decided here": should a renderer's `pty.detach`
ever reach the daemon, given a renderer is the server's viewer and not the
daemon's client (ADR-178 D4)? Tested, not demonstrated, deliberately left.

**`markSeen` read backwards.** Record that `web-app.spec.ts`'s failure was
misread as "the browser never calls `agents.markSeen`" when it meant the
opposite. Short, but it belongs in the record because it was repeated before
it was checked.

**`docs/remote-control.md`'s `LOCAL_ONLY` paragraph** must also say: refused
`LOCAL_ONLY` calls **are** audited as `rejected`/403 (since `6bd3a3d`), with a
null target for methods whose first argument is a secret; and the prewarm pair
is answered inside the browser tab, so a browser never sends it.

**E2E README** (`tests/e2e/README.md`): add `bridge.spec.ts` to whatever index
it keeps; note that `clickMenuItem` now exists in three places and should be
one helper (do not refactor it — just record it); and write down the
unattended-run rule the orchestrator learned the hard way: **a single
Playwright invocation can run longer than an agent's 600s silence watchdog —
run specs individually or in the background.**

**Follow-ups to record, not to do** (a short list at the end of ADR-180's
Consequences):
- A follower's shrunken terminal font is never restored when it becomes the
  owner (`useTerminalResize`).
- The existing `web-app.spec.ts` D6 test's comment claims the browser becomes
  "the pane's only viewer", but `Meta+w` removes the pane for every renderer;
  the new window-close test is the real proof. Reword or retire the old one.
- `agent-hooks.test.ts`'s queue-cap test times out at 5s under full-suite
  load; passes 5/5 in isolation.
