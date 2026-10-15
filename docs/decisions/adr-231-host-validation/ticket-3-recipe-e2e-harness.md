---
title: Share the recipe E2E's desktop side
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Share the recipe E2E's desktop side

ADR-231 D2. This is a refactor of `electron/backend/__tests__/recipe-docker.e2e.test.ts`
with no change in behavior.

## What to build

- **A new file,** `electron/backend/__tests__/recipe-e2e-harness.ts`, that
  exports what both recipe suites need. Parameterise it by a `BoxExec`,
  `(command, {input?, allowFailure?}) => Result`, which runs `sh -c
  command` as the box's `manor` user:
  - the registry and routing setup from `beforeAll` (`BackendRegistry` with
    a real `RecipeHostProvider` and the tarball-loading `ensureHost`, the
    `HostRouting`, the status log);
  - `launchAgent`, `agentActive`, `serverConnected`;
  - `serverPid` and `parentCommand`, over `BoxExec`;
  - `freshServerClient`, taking the exec argv prefix rather than a
    container name;
  - installing the stubs and seeding the project and workspace (the body of
    scenario 1 after adoption);
  - the shared constants (`CLOSED_RELAY_URL`, `REMOTE_AGENT`, the timeouts).
- **The Docker suite** keeps its scenarios, names, order and assertions.
  Only its plumbing goes. `onBox(NAME, …)` becomes the Docker `BoxExec`.
- The harness file has no `describe` or `it`, so vitest doesn't collect
  it. Its name isn't `*.test.ts`. Check that knip accepts it (it is
  imported by test files only). If knip flags it, follow how other
  test-only helpers are allowed.

## Verify

- `pnpm typecheck` and `pnpm lint`.
- `sg docker -c 'node scripts/test-remote-e2e.mjs --recipe'` passes as
  before (10 of 10).

## Files to touch
- `electron/backend/__tests__/recipe-e2e-harness.ts` (new).
- `electron/backend/__tests__/recipe-docker.e2e.test.ts`: use it.
