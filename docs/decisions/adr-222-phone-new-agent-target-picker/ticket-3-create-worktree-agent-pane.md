---
title: createWorktree reports the agent pane id
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# createWorktree reports the agent pane id

ADR-222 D4.

In `src/store/project-store.ts`, `CreateWorktreeOptions` (~line 507) gains:

```ts
/** Called with the pane id of the agent tab opened for `agentPrompt`. */
onAgentPane?: (paneId: string) => void;
```

In `createWorktree` (~line 1216), where the `agent-startup` tab is opened via `addTerminalTab(cmd, { kind: "agent-startup", prompt })`, take the returned `{ paneId }` (it may be null) and call `opts.onAgentPane?.(paneId)` when present. Don't change the return type or any other caller.

Add a unit test (next to existing project-store tests in `src/store/__tests__/`) that mocks the IPC and asserts `onAgentPane` is called with the opened pane id when `agentPrompt` is given and not called otherwise. If the existing test harness makes that impractical, keep the test to whatever level existing createWorktree tests reach and say so in the commit.

## Files to touch
- `src/store/project-store.ts`
- `src/store/__tests__/project-store-create-worktree-agent-pane.test.ts` — new
