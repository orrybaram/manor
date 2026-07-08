---
title: availableSources must ask whether GitHub is actually ready
status: done
priority: high
assignee: sonnet
blocked_by: [7]
---

# availableSources must ask whether GitHub is actually ready

Fixes correctness bug #6.

## The bug

`electron/issue-backends.ts:170-178` promises, in its own docstring:

> *"The sources that can answer a query for this project right now … omitted
> rather than advertised and then failing at call time."*

For Linear this holds — `linearReadiness` checks `isConnected()` and team
associations. For GitHub the check is `if (deps.githubManager)`, and
`githubManager` is constructed **unconditionally** at
`electron/app-lifecycle.ts:141` and handed to `createWebviewServer` at :206. It
is never `null` in production. So:

- `"github"` is always advertised.
- The 503 at `issue-backends.ts:140` is unreachable.
- `GitHubManager.checkStatus()` — the only thing that knows whether `gh` is
  installed and authenticated, and which six renderer components already call —
  is never consulted on this path.

On a machine with no `gh`: `current_workspace` reports `issue sources: github`,
and `list_issues` then 502s.

The test at `electron/issue-backends.test.ts:355` ("an advertised source always
resolves") only asserts `issueBackend(...).ok`, which is exactly the tautology
that hides this.

## What to do

### 1. Memoized readiness on the manager

In `electron/github.ts`:

```ts
private readyPromise: Promise<boolean> | null = null;

/** Memoized: `gh` installed and authenticated. Cleared by `refreshStatus()`. */
async isReady(): Promise<boolean> {
  this.readyPromise ??= this.checkStatus().then(
    (s) => s.installed && s.authenticated,
    () => false,
  );
  return this.readyPromise;
}
```

Memoizing means a user who installs `gh` mid-session must restart Manor before
`list_issues` sees it. That is acceptable and strictly better than today's
always-advertise. If `GitHubManager` already exposes a status-refresh path used
by the settings UI, clear `readyPromise` there.

### 2. `githubReadiness`, mirroring `linearReadiness`

```ts
async function githubReadiness(deps: IssueDeps):
  Promise<{ ready: true; github: GitHubManager } | { ready: false; reason: "not-available" | "not-authenticated" }>
```

`not-available` when `deps.githubManager` is null (tests, headless);
`not-authenticated` when `isReady()` is false. Both map to 503, with distinct
messages — "GitHub is not available" and "GitHub CLI is not installed or not
authenticated. Run `gh auth login`."

### 3. Both readers become async

`issueBackend` and `availableSources` become `async`, and both derive from
`githubReadiness` / `linearReadiness` — preserving the property that the
advertised list and the serving list cannot disagree, which is the whole point of
the seam.

Call sites (both already in async handlers):
- `electron/routes/issues.ts:46` and `:71` — `await issueBackend(...)`
- `electron/routes/context.ts:96` — `await availableSources(...)`

### 4. Fix the tautological test

`issue-backends.test.ts:355` must assert the real property: for **every** source
NOT in `availableSources(...)`, `issueBackend(...)` returns `ok: false`; and for
every source in it, `ok: true`. Add a case with `isReady() → false` and assert
`"github"` is absent from `availableSources` and that `issueBackend(deps, p, "github")`
returns 503.

## Files to touch
- `electron/github.ts` — memoized `isReady()`
- `electron/issue-backends.ts` — `githubReadiness`; `issueBackend` and `availableSources` become async
- `electron/routes/issues.ts`, `electron/routes/context.ts` — `await`
- `electron/issue-backends.test.ts` — replace the tautology with the real bidirectional property
- `electron/__tests__/mcp-webview-server.test.ts` — `/context` `sources` tests need a `githubManager` stub with `isReady`

## Verify
`pnpm typecheck` clean. With `isReady() → false`, `GET /context` omits `"github"`
from `sources` and `GET /projects/x/issues` returns 503 (not 502).
