---
title: Report confirmed launches — paneId in the agent and batch routes
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Report confirmed launches — `paneId` in the agent and batch routes

Ticket 1 makes `startAgent` return the renderer's real answer. This ticket makes
the two callers actually use it, so a failed launch is visible instead of being
reported as success. See ADR-176 Context §2.

## What to build

### 1. `POST /agents` — `electron/routes/agents.ts:287`

`await` the new `startAgent(workspacePath, prompt)`. On success respond `200`
with the renderer's `{ tabId, paneId, workspacePath }`. On failure map
`result.kind` to a status exactly as `proxyToRenderer`
(`electron/renderer-bridge.ts:143`) does: `"unavailable"` → `503`, `"handler"`
→ `400`. If `proxyToRenderer` fits the route as-is after ticket 1, prefer
calling it over duplicating the mapping.

### 2. `BatchResultEntry` — `electron/routes/projects.ts:88`

Add:

```ts
/** Pane the launched agent occupies. Present only when `started` is true. */
paneId?: string;
```

Keep the existing doc comments on `error` / `assignError` / `launchError`
intact — they document a distinction the MCP formatter relies on.

### 3. `batchCreateWorkspaces` — `electron/routes/projects.ts:164`

Two changes in step 3 of the handler:

- **Serialise the launches.** The `details.map` inside `Promise.all`
  (line 256) currently relies on `startAgent` being a synchronous dispatch —
  that assumption is now false, and N concurrent renderer round-trips are both
  unnecessary and harder to reason about. Restructure so the per-issue
  assign/launch work runs in a sequential `for` loop that pushes into
  `results`, preserving input order. **Leave step 1's parallel
  `github.getIssueDetail` fan-out (line 218) and step 2's
  `pm.createWorkspacesFromIssues` exactly as they are** — those are the
  expensive parts and they are already correct.
- **Record the truth.** `entry.started = result.ok` only when the renderer
  confirmed a pane; set `entry.paneId = result.data.paneId` alongside it, and
  `entry.launchError = result.error` otherwise.

Update the block comment above `results` (it currently explains the
`Promise.all` concurrency rationale) to describe the sequential launch and why.

### 4. MCP output — `electron/mcp/tools-agents.ts`

In the `batch_create_workspaces` formatter (around line 282) append the pane to
the `(agent started)` status so an orchestrator can jump straight to the pane or
feed it to `read_session` — e.g. `(agent started, pane abc123)`. Leave the
`failed` / `assign failed` / `launch failed` suffixes as they are.

In `start_agent`'s handler (line 253) the reply is now a body rather than a bare
dispatch — return the pane in the text, e.g.
`Launched agent in <workspacePath> (pane <paneId>).`

### 5. Tests

`electron/routes/` has co-located tests (`agents-manage.test.ts`,
`projects.ts` coverage via the existing suites) — follow whatever mocking
pattern those already use for `renderer-bridge`. Cover:

- `POST /agents` returns `paneId` on success and `503` when the renderer is
  unavailable;
- a batch entry whose launch fails reports `started: false` with
  `launchError` and **no** `paneId`, while its siblings still succeed;
- results stay in input-issue order after the loop rewrite.

## Files to touch
- `electron/routes/agents.ts` — `POST /agents` awaits the ack and returns `paneId`.
- `electron/routes/projects.ts` — `BatchResultEntry.paneId`; sequential launch loop; honest `started`.
- `electron/mcp/tools-agents.ts` — surface `paneId` in both tools' text output.
- `electron/routes/agents-manage.test.ts` (and/or the projects route tests) — cases above.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-176): Report confirmed launches — paneId in the agent and batch routes"

Do not push.
