---
title: Move start-agent into the correlated app-command table with an explicit target
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Move `start-agent` into the correlated app-command table with an explicit target

Fixes the stale-closure bug that makes `start_agent` launch into the previously
active workspace and drop the prompt. See ADR-176 Context §1 for the full
analysis.

## What to build

### 1. New handler in `src/lib/app-commands.ts`

Add a `"start-agent"` entry to the `appCommandHandlers` table. It must be pure
store access — **no React, no imports from `App.tsx`**, matching the module's
existing style and docstring contract.

Arguments (validate with the existing `requireString` / `optionalString`
helpers):

- `workspacePath: string` (required)
- `prompt?: string`
- `agentCommand?: string` — caller-supplied override

Behaviour, in order:

1. If no project in `useProjectStore.getState().projects` has a workspace whose
   `path === workspacePath`, and the path is not `isHomePath`, call
   `await useProjectStore.getState().loadProjects()` once. A workspace created
   moments ago over the control server is not in the store yet, and
   `agentCommand` resolution needs it. **Only refetch when the path is
   genuinely unknown** — `requestRenderer` times out at 5s and an
   unconditional refetch risks turning a successful launch into a reported
   failure.
2. `useAppStore.getState().setActiveWorkspace(workspacePath)`.
3. Resolve the launch command for `workspacePath`, in this precedence:
   - the `agentCommand` argument, if given;
   - `homeLaunchCommand({ homeHarness, homeCustomCommand, homeCustomInterrupt })`
     from `usePreferencesStore.getState().preferences` when
     `isHomePath(workspacePath)`;
   - the owning project's `agentCommand` (find the project whose `workspaces`
     contain `workspacePath`);
   - `DEFAULT_AGENT_COMMAND` from `src/agent-defaults.ts`.
4. If `prompt` is present, build
   `` `${command} "${escapeShellDoubleQuoted(prompt)}"` `` and call
   `useAppStore.getState().setPendingStartupCommand(workspacePath, …)`.
   **Key it off `workspacePath` — never off `activeWorkspacePath`.** This is
   the bug being fixed.
   When `prompt` is absent, set no pending command (the pane boots the base
   agent command on its own, matching today's `handleNewAgent` path minus the
   prewarm, which a correlated launch cannot use because it needs a specific
   command).
5. `const tab = useAppStore.getState().addTab();`
   Throw `new Error("No active panel to open an agent in")` if it returns
   `null` — per the module docstring, a handler that silently does nothing is
   worse than one that errors.
6. Return `{ tabId: tab.tabId, paneId: tab.paneId, workspacePath }`.

Helpers to reuse: `homeLaunchCommand` and `escapeShellDoubleQuoted` from
`src/lib/home.ts`, `isHomePath` from `src/lib/home-path.ts`,
`DEFAULT_AGENT_COMMAND` from `src/agent-defaults.ts`.

### 2. Delete the legacy branch in `src/App.tsx`

Remove the `if (cmd === "start-agent" && workspacePath)` branch from the
`onAppCommand` effect (around `src/App.tsx:391`) so `start-agent` falls through
to the correlated `appCommandHandlers` dispatch below it. Leave the
`run-setup-script` branch alone — it is out of scope.

`handleNewAgentWithPromptRef` may now be unused by the app-command path; it is
still used by the UI (`onNewAgentWithPrompt` props). Keep the ref only if
something still reads it, and drop it if `knip` flags it as dead.

### 3. Make `startAgent` correlated in `electron/renderer-bridge.ts`

Replace the fire-and-forget `startAgent` (line 161) with:

```ts
export async function startAgent(
  workspacePath: string,
  prompt?: string,
  agentCommand?: string,
): Promise<RendererResponse<{ tabId: string; paneId: string; workspacePath: string }>>
```

implemented over `requestRenderer("start-agent", { workspacePath, prompt, agentCommand })`.
Follow the existing convention: resolve, never reject. Keep the surrounding
doc comment accurate — it currently says agents are launched by `App.tsx`
seeding a shell command; they are now launched by the correlated handler.

Update the two call sites so the build stays green — `electron/routes/agents.ts:299`
and `electron/routes/projects.ts:280` — with a minimal `await` plus the existing
`ok` check. Ticket 2 reworks what those routes *report*; this ticket only keeps
them compiling and behaviourally equivalent.

### 4. Tests

`src/lib/__tests__/app-commands.test.ts:947` asserts
`appCommandHandlers["start-agent"]` is `undefined`. Invert it, and add coverage:

- prompt lands in `setPendingStartupCommand` **keyed to the requested
  `workspacePath`**, while a *different* workspace is active beforehand — this
  is the regression test for the bug;
- the resolved command uses the requested workspace's project `agentCommand`,
  not the previously active one's;
- explicit `agentCommand` argument wins over the project's;
- `isHomePath` target uses `homeLaunchCommand`;
- no `prompt` ⇒ no pending startup command;
- returns `{ tabId, paneId }`;
- throws when `addTab()` returns `null`.

## Files to touch
- `src/lib/app-commands.ts` — new `start-agent` handler; update the module docstring, which currently names `start-agent` as a fire-and-forget exception.
- `src/App.tsx` — delete the legacy `start-agent` branch in the `onAppCommand` effect.
- `electron/renderer-bridge.ts` — `startAgent` becomes async over `requestRenderer`.
- `electron/routes/agents.ts` — `await` the new signature (minimal change).
- `electron/routes/projects.ts` — `await` the new signature (minimal change).
- `src/lib/__tests__/app-commands.test.ts` — invert the absence assertion, add the cases above.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-176): Move start-agent into the correlated app-command table with an explicit target"

Do not push.
