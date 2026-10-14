---
title: The recipe provider
status: in-progress
priority: critical
assignee: opus
blocked_by: [1, 2]
---

# The recipe provider

ADR-229 D2. A `HostSpec` of `{kind: "recipe", recipeId}` starts, stops and
deletes its host with user-owned commands, and reaches the host over SSH
or exec.

## What to build

- **`HostSpec`** gains `{ kind: "recipe"; recipeId: string }` in
  `electron/backend/types.ts`, mirrored in `src/store/host-store.ts`.
  - `PersistedHost` loading accepts it.
  - Every place that reads `spec.target` must handle the new kind:
    `HostIndicator` labels, `RemoteBackend` construction in `registry.ts`,
    `hosts.add`, and the ssh-target display. For a recipe host, the label is
    the recipe's `name`.
- **Recipe store** (`electron/backend/providers/recipes.ts`)
  - Read and write `~/.manor/host-recipes/<id>/recipe.json` with the
    ADR-229 D2 schema: `schemaVersion`, `id`, `name`, `template?`, `up`,
    `status?`, `stop?`, `destroy?`, `idleStopMinutes?`, `env?`.
  - Validation is strict: unknown keys are refused, and command paths must
    resolve inside the recipe dir or be absolute.
  - Recipes are read only from there, never from a project or repo.
- **Command runner.** It spawns the command in its own process group, with:
  - cwd set to the recipe dir;
  - env = `process.env` + `recipe.env` + `MANOR_HOST_ID`, `MANOR_RECIPE_DIR`
    and `MANOR_INSTANCE_ID` (the resource id once known, else the host id);
  - `{hostId, resource}` as JSON on stdin.

  Stdout is collected, capped at 64 KB, and must parse as **exactly one**
  JSON object. Stderr streams line by line to `onProgress`. Timeouts are
  `up` 15 min, `stop`/`status` 2 min, `destroy` 10 min, and a timeout kills
  the group. Failures carry the command, the exit code and the stderr tail
  (2 KB).
- **`up` result validation:**
  - `schemaVersion: 1`;
  - optional `resource` (any JSON, stored in the recipe's host state);
  - `connection` is either:
    - `{type: "ssh", target: {host, port, username, identityFile?, identitiesOnly?, jumpHost?, proxyCommand?, hostKey?}}`,
      where `jumpHost` and `proxyCommand` together are refused; or
    - `{type: "exec", argv: string[]}` (non-empty);
  - optional `autoSleep: boolean`.
- **`status` result:** `{state: "up" | "sleeping" | "missing" | "error", detail?}`.
  `missing` maps to provider state `error`, with
  `detail: "<name> no longer exists"`, plus a flag that the UI uses to offer
  **Start it again**.
- **`RecipeHostProvider`** (`electron/backend/providers/recipe-provider.ts`)
  - `ensureUp` runs `up`, stores `resource`, and builds the inner provider
    when the connection changed:
    - **ssh:** write a `Host manor-<hostId>` stanza into Manor's managed ssh
      config (`ssh-config.ts`) with HostName, Port, User, IdentityFile,
      IdentitiesOnly, ProxyJump or ProxyCommand,
      `UserKnownHostsFile ~/.manor/ssh/known_hosts.d/<hostId>` and
      `StrictHostKeyChecking yes`, or `accept-new` when the file has no key
      yet and `up` returned none. Write `hostKey`, when given, into that
      file, replacing earlier keys for the host. Then build a
      `SshHostProvider("manor-<hostId>")`.
    - **exec:** build a `CommandHostProvider(argv)` (ticket 2).
  - `transport()` returns the inner provider's transport.
    `RemoteBackend`/`HostConnection` must cope with the transport not
    existing before the first `ensureUp`. Order it so `ensureUp` always runs
    first (ticket 1) and the backend is built or rebound after that. Keep
    the change small and explain it in a comment.
  - `status()` runs `status` if present, else reports the last known state.
  - `stop` and `destroy` run their commands. After `destroy`, the recipe dir
    is removed by the caller (ticket 8), not here.
  - `setBusy` stores the flag for ticket 6's idle stop.
  - `capabilities` come from which commands exist, plus `autoSleep` from
    the last `up`.
  - A host-key mismatch on connect is a `HostFailure` ("\<name\>'s host key
    changed and the recipe didn't vouch for the new one"), not a retry loop.
- **`createProvider`** gets the `recipe` case.
- **`hosts.addRecipeHost(recipeId)`** (owner-only) registers the host
  (`PersistedHost.spec = {kind:"recipe", recipeId}`) and starts a connect,
  so `up` runs with progress in the host status. Ticket 8 adds the UI.

## Carried over from tickets 1 and 2

- **Bootstrap wording over exec.** `remote-bootstrap.ts` reads exit 255 as
  "ssh to X failed while bootstrapping". Over exec, 255 comes from
  kubectl/docker. Make the wording depend on the transport (or take it from
  the transport's `exitError`).
- **Give `CommandTransport` a friendly `label`**: the recipe's `name`. The
  default is the joined argv.
- **`CommandHostProvider.kind` is `"recipe"`** today (ticket 2). Decide
  whether the outer `RecipeHostProvider` is the only `kind: "recipe"` and the
  inner providers are internal. Keep `hosts.list`'s `providerKind` meaning
  "how the host was configured".
- **Wake timeouts** (ticket 1). `hosts.wake` and `HostRouting` wait 2 min,
  and the renderer waits 10 s for the bridge. A recipe `up` may run 15 min.
  Either make the wake wait follow the provider (`ensureUp` progress keeps it
  alive), or refuse with a stated "\<host\> is still starting" instead of
  host-away.

## Tests

- Runner:
  - single-JSON stdout is enforced (stray echo → error naming it);
  - stderr becomes progress;
  - timeouts kill the group;
  - stdin carries `{hostId, resource}`.
- Validation: each refusal (unknown key, jumpHost + proxyCommand, empty
  argv, wrong schemaVersion).
- Provider with fixture shell scripts:
  - `up` → ssh stanza written with the right known_hosts handling;
  - `up` → exec builds a command provider;
  - `status` mapping, including `missing`;
  - `stop`/`destroy` only when present.

## Files to touch
- `electron/backend/types.ts`, `src/store/host-store.ts`
- new `electron/backend/providers/recipes.ts`, `recipe-provider.ts`, `recipe-runner.ts`
- `electron/backend/providers/index.ts`, `electron/backend/registry.ts`, `electron/backend/host-connection.ts`
- `electron/terminal-host/ssh-config.ts` (per-host stanza and known_hosts)
- `electron/projects/types.ts` / `host-records.ts` (spec persistence)
- `electron/bridge/handlers/hosts.ts`, `electron/bridge/routes.ts`
- `src/components/hosts/HostIndicator.tsx` (label)
