---
title: The surface is checked at compile time
status: in-progress
priority: critical
assignee: opus
blocked_by: [11]
---

# The surface is checked at compile time

ADR-180 D7. This is the ticket that keeps the drift dead. Without it, ADR-180
is a one-time cleanup and the next feature starts a new `ipc/`.

## The check

`src/electron.d.ts`'s `ElectronAPI` is the contract. Derive the full set of
`ns.method` strings from it at the type level:

```ts
type Methods<T> = {
  [N in keyof T & string]: T[N] extends Record<string, unknown>
    ? { [M in keyof T[N] & string]: T[N][M] extends Function ? `${N}.${M}` : never }[keyof T[N] & string]
    : never;
}[keyof T & string];
```

Then assert that every one of them is placed in exactly one of three sets:

1. `HANDLERS` — the bridge table (`electron/bridge/handlers.ts`)
2. `NATIVE_METHODS` — the preload's `native` namespaces, as a literal `as const`
   tuple that `preload.ts` itself builds its object from, so the two cannot
   diverge
3. `LOCALLY_SERVED` — answered in the tab (`src/bridge/unavailable.ts`)

The assertion is a type error, not a runtime one:

```ts
type Unplaced = Exclude<Methods<ElectronAPI>, PlacedMethod>;
type Duplicated = /* in two sets */;
const _unplaced: Unplaced extends never ? true : Unplaced = true;
const _duplicated: Duplicated extends never ? true : Duplicated = true;
```

When it fails, the error names the method, which is the whole point — put a
comment above it saying so, because the next person to see it will be adding a
method and wondering what they did wrong.

`electron/bridge/handlers.ts` is Node-side and `ElectronAPI` is renderer-side;
importing a *type* across that line is already precedent (`electron/mcp/tools-panes.ts`
imports `LayoutSnapshot` from `src/store/`). If `HANDLERS`' keys need to be
literal for this, type it `Record<PlacedMethod, BridgeHandler>` and let the
object literal's keys be checked by assignment.

## Runtime tests to update

- `electron/remote-control/__tests__/allowlist.test.ts` — keeps every family
  exclusion for `read` and `send`; add "the `full` tier is the whole table
  minus `LOCAL_ONLY`", and assert `LOCAL_ONLY`'s membership by name so
  loosening it is a visible diff.
- New `electron/bridge/__tests__/caller-class.test.ts`: a `device` connection
  calling each `LOCAL_ONLY` method gets `unavailable:web`; a `local`
  connection gets through; a `local` call leaves no audit line and a `device`
  call to a `MUTATING` method leaves one.
- New `src/bridge/__tests__/resolution.test.ts`: the proxy's resolution order
  (native → locally served → unavailable namespace → transport) for one
  method of each kind.

## Files to touch
- `electron/bridge/surface.ts` — new; `Methods<>`, `PlacedMethod`, the two assertions
- `electron/bridge/handlers.ts` — key the table by `PlacedMethod`
- `electron/preload.ts` — build `native` from the `NATIVE_METHODS` tuple
- `src/bridge/unavailable.ts` — export `LOCALLY_SERVED`'s keys as a literal type
- `electron/remote-control/__tests__/allowlist.test.ts` — the full-tier assertion
- `electron/bridge/__tests__/caller-class.test.ts` — new
- `src/bridge/__tests__/resolution.test.ts` — new

## Folded in from ticket 10

Two shapes the exhaustiveness check should be aware of, both introduced while
the namespaces crossed:

- **`linear.connect` is `LOCAL_ONLY`, not native.** It is the one method whose
  *argument* is a credential. Keeping it in the preload would have meant
  keeping one `ipcMain.handle` alive in a file D8 says to empty, so it is on
  the table and refused to every device instead. It is deliberately out of
  `MUTATING`, because `bridgeTarget` records an audited call's first string
  argument — which for `connect` is the API key. Assert that: a method whose
  first argument is a secret must never be in `MUTATING`, and this is the one
  place that rule is written down.
- **Optional arguments arrive as `undefined` over IPC and `null` over the
  socket**, and a default parameter only fires for `undefined`. Ticket 10 hit
  this in `github.getMyIssues`/`getAllIssues`, where without a `?? undefined`
  the first browser to open the issue picker asks `gh` for `--limit null`. It
  is a whole class of bug the type system cannot see, because both callers
  satisfy the same signature. If the check can catch it, catch it; if not,
  say so here so the next person knows it is unguarded.

## Folded in from ticket 11

**`electron/bridge/handlers.ts`'s header is now stale, and you are the ticket
that rewrites it.** It still says the table will be reached by "every Electron
renderer window too *once* ADR-180 D2's IPC transport joins them" — that
happened seven tickets ago — and its middle paragraph narrates which ADR-*178*
ticket added which entry, which now reads as if it meant this ADR's tickets.
Replace the narration with the final state: one table, two transports, every
caller; what `LOCAL_ONLY` means and why; and the D7 check as the thing that
keeps it honest. The security paragraph at the end is still exactly right —
keep it.

**`electron/preload.ts` ended at 480 lines, not the "well under 300" this
ADR's D8 asked for.** Ticket 11 judged the gap honestly: `webview`'s 27
methods are ~250 lines on their own, plus the argv facts and the
bridge-event plumbing. Getting under 300 means splitting `preload.ts` into
several files, which is a different change. Do not chase the number; ticket 13
corrects D8's claim instead.
