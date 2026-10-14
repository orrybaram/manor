---
title: A recipe host in Playwright, over the harness's sshd
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# A recipe host in Playwright, over the harness's sshd

ADR-231 D6, the shared part. Tickets 7 and 8 use this.

## What to build

`tests/e2e/helpers/recipe-host.ts`:
- **`writeSshRecipe(tempHome, {id, name, idleStopMinutes?})`.** It writes
  `${tempHome}/.manor/host-recipes/<id>/`:
  - `recipe.json`: `schemaVersion: 1`, `id`, `name`, `up: "./up.sh"`,
    `stop: "./stop.sh"`, and `idleStopMinutes` if given. **No `status`.**
    Check the exact fields against `electron/backend/providers/recipes.ts`.
  - `up.sh`: appends a line to `up-count` in its own directory
    (`$MANOR_RECIPE_DIR`), then prints one JSON object on stdout:
    `{"schemaVersion":1,"connection":{"type":"ssh","target":{"host":"127.0.0.1","port":<P>,"username":"<U>","identityFile":"<key>"}}}`.
    - P, U and the key come from the `manor-e2e-direct` block of
      `MANOR_E2E_SSH_CONFIG`. Parse it in the helper and write the literal
      values.
    - Match the schema in `recipes.ts:238-350`, e.g. whether
      `identitiesOnly` is allowed.
  - `stop.sh`: prints `{}`.
  - Both scripts get mode 0755.
- **`upCount(tempHome, id)`** reads the counter.
- **`addRecipeHost(window, id)`** calls
  `window.electronAPI.hosts.addRecipeHost(id)` and returns the host id.
  Check the handler at `electron/bridge/handlers/hosts.ts:82-107` for its
  signature and result.

`tests/e2e/helpers/remote-project.ts`:
- `openRemoteProject` takes an optional `{hostId, hostLabel}`. With it, the
  function skips `hosts.add(APP_TARGET)` and picks that host's option in
  the Add Project dialog instead of `manor-e2e`. Without it, it behaves
  exactly as today.

A smoke test, `tests/e2e/recipe-host.spec.ts` (gated like the other remote
specs):
- register the recipe host, open a remote project on it and run a command
  in a pane;
- `hosts.stop` → `sleeping`;
- `hosts.wake` → `connected`;
- `upCount` is 2.

Add it to `PLAYWRIGHT_SUITES`. Never register the ssh host and the recipe
host in the same test.

## Verify

`DISPLAY=:0 node scripts/test-remote-e2e.mjs --playwright-only -- tests/e2e/recipe-host.spec.ts`
passes, and `remote-host.spec.ts` still passes.

## Files to touch
- `tests/e2e/helpers/recipe-host.ts` (new).
- `tests/e2e/helpers/remote-project.ts`: the host option.
- `tests/e2e/recipe-host.spec.ts` (new).
- `scripts/test-remote-e2e.mjs`: `PLAYWRIGHT_SUITES`.
