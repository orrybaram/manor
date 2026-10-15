---
title: A recipe host re-runs up once per drop
status: done
priority: high
assignee: opus
blocked_by: []
---

# A recipe host re-runs up once per drop

ADR-230 D2 (gap L2). A reconnect reuses the last way in, so a recipe box at a
new address is never found until a full connect or wake.

## What to build

- **Attempt number.**
  - `ReconnectSupervisor` (`electron/terminal-host/reconnect-supervisor.ts`):
    `beforeAttempt?: (attempt: number) => Promise<boolean>` (:72, :93).
    Pass it from `run` (:183) through `mayAttempt(attempt)` (:239-247).
  - Thread the number through `beforeReconnect` in
    `electron/backend/remote-backend.ts` (:109, :150) and
    `electron/backend/registry.ts` (:74, :95, :240).
- **`RemoteHostConnection.beforeReconnect(attempt)`**
  (`electron/backend/host-connection.ts:610-621`):
  - Keep the existing sleeping and missing checks.
  - Then, for a provider whose `kind === "recipe"`, re-run `up` when all of
    these hold:
    - `attempt >= 2`;
    - `up` hasn't already been re-run during this drop;
    - the recipe has a `status` command, or doesn't declare
      `capabilities.autoSleep`. Check `recipe-provider.ts:213-219`.

    Re-run it with `await this.provider.ensureUp()`.
  - Prefer an optional `HostProvider.refresh?()` in
    `electron/backend/providers/types.ts`, which only the recipe provider
    implements, over checking `kind`.
  - The "already re-run" flag resets on `hostReconnected`.
  - Catch and log errors. Don't mark the host failed; return true so the
    redial goes on.
- **`RecipeHostProvider`** (`electron/backend/providers/recipe-provider.ts`):
  - `ensureUp` deduplicates in-flight calls with one shared promise, as
    `statusRun` (:191) already does;
  - `bind()` (:393-409) still rebinds only when the connection changed.
    Confirm that disposing the old inner transport during a redial is safe,
    because no live streams are left after a drop.
- **Progress.** `reportProgress` (`host-connection.ts:624-627`) also shows
  lines while `reconnecting`.

## Tests (each must fail on the base commit)

- `electron/terminal-host/__tests__/reconnect-supervisor.test.ts`:
  `beforeAttempt` receives 0, 1, 2, …
- `electron/backend/__tests__/registry.test.ts`, in "provider lifecycle
  (ADR-229 D1)" (:1018+):
  - a recipe fake provider whose second `up` returns a different
    connection: after a drop the host reconnects to the new one;
  - `up` runs once per drop, not on attempt 0 or 1;
  - `up` doesn't run when the recipe is autoSleep with no `status`;
  - a failing `up` keeps redialling.
- `electron/backend/__tests__/recipe-provider.test.ts`: two concurrent
  `ensureUp` calls run `up` once.

## Files to touch
- `electron/terminal-host/reconnect-supervisor.ts`
- `electron/backend/remote-backend.ts`, `electron/backend/registry.ts`
- `electron/backend/host-connection.ts`
- `electron/backend/providers/types.ts`, `electron/backend/providers/recipe-provider.ts`
- Tests named above.
