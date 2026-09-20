---
title: Make typecheck a gate, so D7 is real
status: done
priority: critical
assignee: opus
blocked_by: [12]
---

# Make typecheck a gate, so D7 is real

Found by ticket 12, and it is the one thing standing between this ADR and its
own promise.

## The problem

D7 says the surface check is "a type error, not a runtime one". Ticket 12 built
it, and it works — adding an unplaced method produces:

```
electron/bridge/surface.ts(260,14): error TS2322: Type 'boolean' is not assignable to type
'Complaint<"ADR-180 D7 — place this method: HANDLERS, nativeApi, LOCALLY_SERVED or SUBSCRIPTIONS", "pty.frobnicate">'.
```

But **nothing in this repo runs `tsc`.** `pnpm build` is Vite, which strips
types without checking them. `pnpm test` is Vitest, same. So the check fires in
an editor, and under a manual `npx tsc -p tsconfig.electron.json`, and nowhere
else. A contributor who adds a method, does not look at the squiggle, and sees
a green `pnpm build` has defeated D7 without knowing it existed.

This is not a new problem — `tsconfig.electron.json` has carried a 15-error
baseline across 6 files for the whole of ADR-180, which is itself only possible
because nothing enforces it. ADR-180 is what makes it worth fixing: the drift
it ends stays ended only if the check that ends it runs.

## What to build

1. **Clear the baseline.** 15 errors in 6 files, mostly stale fixtures in test
   files. Fix them properly — a fixture that no longer matches its type is a
   test asserting something that cannot happen. If one of them is a real bug
   like `ipc/pty.ts:127` turned out to be (a dropped `env` parameter,
   ADR-135 ticket 7's intent unrealised), say so loudly in the commit; that is
   the second time this baseline has been hiding one.
   `tsconfig.json` has a 1-error baseline too (`electron/notifications.ts:152`)
   — clear that as well.
2. **Add a `typecheck` script** that runs both configs, and make it part of the
   gate: `pnpm build` should not pass while types do not. Wire it however this
   repo's scripts are shaped — a `pretest`/`prebuild` hook, or a `check` script
   that CI and the verifier call. Whatever you choose, the property to hold is
   that **a green local run means D7 ran.**
3. **Update `.claude/agents/verifier.md`.** It currently says `bun run
   typecheck` and `bun run build`; this repo uses `pnpm`, and the typecheck
   command it names has never existed. That staleness is why every ADR-180
   ticket was told "the gate is `pnpm build`" by hand.
4. **`electron/bridge/surface.ts`'s header** currently admits the check does not
   run in CI. Once it does, correct it — and keep the sentence about what the
   check still cannot see (the publisher side of `SUBSCRIPTIONS`, and the
   `null`-vs-`undefined` optional-argument hazard from ticket 10). An honest
   list of remaining holes is worth more than a claim of completeness.

## Verification

- Add an unplaced method to `ElectronAPI`, run the gate, watch it fail with the
  method's name in the message. Remove it.
- The full suite still passes: 3047 unit tests, and E2E's known failures only.

## Files to touch
- `tsconfig.electron.json`'s 6 offending files — fix, do not suppress
- `electron/notifications.ts:152` — the `tsconfig.json` baseline error
- `package.json` — the `typecheck` script and its place in the gate
- `.claude/agents/verifier.md` — the commands it names must exist
- `electron/bridge/surface.ts` — header, once the claim is true
