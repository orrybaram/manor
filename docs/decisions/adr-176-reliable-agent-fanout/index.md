---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-176: Reliable agent fan-out — explicit-target launches, real acks, an orchestrator primer

## Context

Telling an agent *"use manor to create workspaces and tackle these tickets"*
does not reliably produce one agent per ticket, running in the right workspace,
holding the right prompt. Three separate defects stack up.

### 1. `start_agent` launches into the *previously* active workspace

`src/App.tsx:388` handles the legacy fire-and-forget `start-agent` app-command:

```ts
if (cmd === "start-agent" && workspacePath) {
  await loadProjects();
  setActiveWorkspace(workspacePath);
  if (prompt) handleNewAgentWithPromptRef.current(prompt);
  else handleNewAgentRef.current();
  return;
}
```

`handleNewAgentWithPrompt` (`src/App.tsx:563`) closes over the **React state**
values `activeWorkspacePath` and `activeWorkspaceCommand`:

```ts
const handleNewAgentWithPrompt = useCallback((prompt: string) => {
  if (activeWorkspacePath) {
    const command = `${activeWorkspaceCommand} "${escapeShellDoubleQuoted(prompt)}"`;
    useAppStore.getState().setPendingStartupCommand(activeWorkspacePath, command);
  }
  addTab();
}, [addTab, activeWorkspacePath, activeWorkspaceCommand]);
handleNewAgentWithPromptRef.current = handleNewAgentWithPrompt;
```

`setActiveWorkspace(workspacePath)` is a synchronous Zustand write, but the ref
is only reassigned on the **next render**. Invoking it in the same microtask
therefore runs the closure built for the *old* active workspace. The result is a
split brain:

| call | reads | lands on |
| --- | --- | --- |
| `setPendingStartupCommand(activeWorkspacePath, cmd)` | stale React closure | **old** workspace |
| `addTab()` (`src/store/app-store.ts:784`, via `getActivePanelContext(get())`) | fresh store | **new** workspace |

So the new workspace opens a bare agent with **no prompt**, and the old
workspace is left holding a pending startup command that fires on its next pane.
`activeWorkspaceCommand` is stale the same way, so the launch can even use
another project's configured `agentCommand`.

Under fan-out this compounds: `batchCreateWorkspaces`
(`electron/routes/projects.ts:256`) maps `startAgent` over `Promise.all`, and
each handler `await loadProjects()` before touching the store — so N handlers
interleave around one shared `activeWorkspacePath`.

`src/lib/app-commands.ts` already exists as the React-free, correlated dispatch
table for exactly this class of command, and its own docstring flags
`start-agent` as one of two stragglers left behind.

### 2. Nothing confirms a launch happened

`startAgent` (`electron/renderer-bridge.ts:161`) returns `{ ok: true }` as soon
as a `BrowserWindow` exists — it never learns whether a pane was created or the
prompt was delivered. `BatchResultEntry.started` is built from that, so the
batch tool cheerfully reports "(agent started)" for launches that silently
landed nowhere. An orchestrator has no signal to retry on. The correlated
`requestRenderer` path (`electron/renderer-bridge.ts:102`) already solves this
for every other renderer-owned command.

### 3. No fan-out guidance reaches the agent

The SessionStart hint (`electron/scripts/agent-hook.js:118`) is one sentence:
run `manor --help`. ADR-153 ticket-5 specified `src/lib/orchestrator-primer.ts`
with a tool catalog and house rules — **that file was never written**. An agent
asked to fan a backlog out has to rediscover `batch-create-workspaces` from
`--help` every session, and more often hand-rolls `create-workspace` +
`start-agent` per issue, or just does the work itself in the current workspace.

## Decision

### Promote `start-agent` to a correlated, explicitly-targeted app-command

Move the handler out of `App.tsx`'s ref-closure path and into
`src/lib/app-commands.ts`, alongside every other correlated command. The handler
takes its target explicitly and never reads React state:

1. `useProjectStore.getState().loadProjects()` when `workspacePath` is not yet
   in the store (a freshly created worktree), so `agentCommand` resolves.
2. `setActiveWorkspace(workspacePath)`.
3. Resolve the launch command for **that path** — caller-supplied
   `agentCommand`, else the owning project's, else `homeLaunchCommand(prefs)`
   for `isHomePath`, else `DEFAULT_AGENT_COMMAND`.
4. `setPendingStartupCommand(workspacePath, command)` — the explicit path, never
   a closed-over one.
5. `addTab()` and return its `{ tabId, paneId }`.

Step 4 keying off the same `workspacePath` as step 2 is the whole fix: store
reads and store writes now agree on one target.

`startAgent` in `electron/renderer-bridge.ts` becomes `async` over
`requestRenderer("start-agent", …)`, returning the renderer's
`{ tabId, paneId }` or the real failure.

### Make both callers await the ack

`POST /agents` (`electron/routes/agents.ts:299`) and `batchCreateWorkspaces`
await the new result and report what actually happened. `BatchResultEntry` gains
`paneId`, and `started` becomes true only on a confirmed pane. The batch route
launches **sequentially** rather than inside `Promise.all` — each launch is now a
renderer round-trip, and serialising removes any remaining interleave while
keeping the expensive `gh` reads parallel.

### Ship the orchestrator primer

Write `src/lib/orchestrator-primer.ts` as the canonical text (manor's
project → workspace → pane → agent model, the observe/act tool catalog, and the
house rules from ADR-153 ticket-5: concurrency cap, confirm before destructive
actions, no recursive spawning), and widen
`agent-hook.js`'s `SESSION_START_HINT` with a compact fan-out playbook that
names `batch-create-workspaces` as the one-shot path and `list-agents` /
`read-session` as the verification path. `agent-hook.js` is a standalone script
Claude Code executes directly and cannot import TypeScript, so it carries its
own literal; a unit test pins the two in agreement.

## Consequences

**Better.** `start_agent` puts the agent in the workspace it was asked for, with
the prompt it was given, under the right project's `agentCommand` — single or
fanned out. Callers get a `paneId` back, so a failed launch is visible and
retryable instead of silently reported as success. `app-commands.ts` loses one
of its two documented exceptions and the behaviour becomes unit-testable without
mounting `App.tsx`. An agent told to "tackle these tickets" has the playbook in
context from the first turn.

**Harder.** `startAgent` becomes async, so every call site must await it —
`renderer-bridge.ts`'s synchronous signature is a small breaking change inside
electron. Batch launches serialise, so a large fan-out takes slightly longer in
wall-clock (bounded by the 5s `requestRenderer` timeout per launch); worktree
creation and `gh` reads stay parallel, so the added cost is the launch
round-trips only. The SessionStart hint grows, costing tokens in every Claude
Code session inside Manor — kept deliberately compact for that reason.

**Risks.** `requestRenderer` resolves `ok: false` on a 5s timeout; a slow
`loadProjects()` inside the handler could trip it on a cold start, turning a
launch that *did* happen into a reported failure. The handler therefore only
refetches when the path is genuinely unknown. `app-commands.test.ts:947`
currently asserts `start-agent` is absent from the table — that expectation
inverts.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
