---
title: Use buildResumeCommand in the relaunch path with bare-command fallback
status: done
priority: critical
assignee: sonnet
blocked_by: [2]
---

# Wire resume into the relaunch path

Replace the bare-command relaunch in the interrupted-task recovery branch so a
cold/fresh-restored pane resumes its prior agent session. See ADR-144.

## Requirements

In `src/hooks/useTerminalLifecycle.ts`, the resume branch currently reads
(around lines 287-299):

```ts
void (async () => {
  const activeTasks = await window.electronAPI.tasks.getAll({ status: "active" });
  const resumeTask = activeTasks.find(
    (t) => t.paneId === paneId && !t.resumedAt && t.agentCommand,
  );
  if (!resumeTask || disposed) return;

  // Mark resumed immediately to prevent double-launch on re-mount
  void window.electronAPI.tasks.markResumed(resumeTask.id);

  // Wait for shell prompt (CWD event), then relaunch
  sendOnShellReady(resumeTask.agentCommand!);
})();
```

Change the final two steps to build the resume command first, falling back to the
bare agent command if it comes back `null`:

```ts
if (!resumeTask || disposed) return;

// Mark resumed immediately to prevent double-launch on re-mount
void window.electronAPI.tasks.markResumed(resumeTask.id);

// Resume the prior agent session if we can; otherwise relaunch the bare command.
const resumeCmd = await window.electronAPI.tasks.buildResumeCommand(resumeTask.id);
if (disposed) return;
sendOnShellReady(resumeCmd ?? resumeTask.agentCommand!);
```

Notes:
- Keep `markResumed` BEFORE the `await` (preserves the existing double-launch guard
  on re-mount).
- Re-check `disposed` after the new `await`, consistent with the surrounding code.
- No other branch of `useTerminalLifecycle` changes; warm restore is untouched.

## Files to touch
- `src/hooks/useTerminalLifecycle.ts` — swap the bare relaunch for the
  `buildResumeCommand` result with a bare-command fallback.
