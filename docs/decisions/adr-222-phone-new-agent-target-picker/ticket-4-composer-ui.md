---
title: PhoneNewAgentComposer with target chips, send, and wiring
status: done
priority: high
assignee: opus
blocked_by: [1, 2, 3]
---

# PhoneNewAgentComposer with target chips, send, and wiring

ADR-222 D5 + D6. Read `docs/decisions/adr-222-phone-new-agent-target-picker/index.md` first.

## Component
New `src/components/phone/NewAgent/PhoneNewAgentComposer.tsx` + `.module.css`. Move the body of `src/components/phone/PhoneEmptyWorkspace.tsx` (logo mark, `Greeting`, `RecentAgents`, composer) into it; `PhoneEmptyWorkspace` becomes `return <PhoneNewAgentComposer closable={false} />`. Keep existing testids (`phone-empty-workspace`, `phone-empty-composer-input`, `phone-empty-send`, `phone-recent-agents`) so `phone*.spec.ts` keeps passing.

- Text + target live in `useAppStore().composerDraft` (ticket 1). On mount, if `target` is null or `resolveTarget` returns null, seed with `seedTarget(...)` from the active workspace key.
- **Chip row** (testid `phone-target-chips`) directly above the composer field, inside the `data-keyboard-lift` container, horizontally scrollable, no wrap:
  - Host chip (testid `phone-target-host`) — only when `hostChoices` is non-null. Label `memberHostName`, icon as in `src/components/sidebar/HostPicker.tsx` / `HostIndicator`.
  - Project chip (testid `phone-target-project`) — `Folder` lucide icon + project name.
  - Workspace chip (testid `phone-target-workspace`) — `GitBranch` icon + workspace label, a thin divider, then `<Checkbox>` "worktree" (testid `phone-target-worktree`).
  - Chips are `Button variant="ghost"`; style to match the Claude-app screenshot: rounded 8px, subtle filled bg (`var(--surface-2)`-ish tokens already in the phone CSS), 13px text, 28–32px tall.
- **Choice list**: tapping a chip opens an inline list above the composer reusing the `ChatPane/CommandChoiceSheet.tsx` pattern (backdrop + list, focus stays in the textarea, Escape/backdrop closes). Rows are `Button`s showing a check on the current value; disabled host rows show `disabledReason`; project rows show the color dot; workspace rows show label + branch (dimmed) when they differ. Testid `phone-target-choices`, rows `phone-target-choice`.
- **Greeting** subline follows the resolved target: "Claude is ready in <name> on <branch>." or, with worktree on, "Claude will start a new worktree off <branch>." The recents rail filters by the target workspace path + host (`recentWorkspaceAgents`).
- `closable` prop: when true, show a close `Button` (lucide `X`, `aria-label="Close"`, testid `phone-composer-close`) top-right of the screen that calls `closeComposer()`. Optionally a Tooltip.

## Send — `src/components/phone/NewAgent/useNewAgentSend.ts`
Implement ADR-222 D6 exactly:
- Existing/main: `launchAgentInWorkspace(path, { prompt, hostId: project.hostId })`; `markChatStarting` when `getAgentKindForCommand(resolveWorkspaceCommand(key)) === "claude"`; `setGroupLastUsedHost` for grouped projects; `clearComposerDraft()`; `closeComposer()`.
- New worktree: `name = worktreeNameFromPrompt(prompt, taken)`, `branch = sanitizeBranchName(name)`, `baseBranch = isMain ? undefined : workspace.branch`; `closeComposer()` then `await createWorktree(project.id, name, { branch, baseBranch, agentPrompt: prompt, onAgentPane: (id) => claude && markChatStarting(id) })`; on a non-null result `clearComposerDraft()`; on null leave the draft (error toast already fires) — reopen not required.
- ⌘/Ctrl+Enter sends; plain Enter is a newline (as today).

## Wiring
- `src/App.tsx`: on phone, `handleNewAgent` calls `useAppStore.getState().showComposer()` instead of `startNewAgent`. Desk path unchanged. The composer surface (ticket 1) renders `<PhoneNewAgentComposer closable />`.
- Check every phone entry point now opens the composer: drawer pill + empty-state button (`PhoneAgentsPanel`), TabBar `+` phone path (`TabBar.tsx:603-631`), palette.

## Tests
- Extend/adjust `src/components/phone/__tests__/phone-empty-state.test.ts` if helpers moved.
- A render test for the composer in the style of existing phone component tests: host chip hidden for unlinked project, shown for a group; toggling worktree changes the greeting.
- Use the `react` skill conventions; UI components from `src/components/ui/` only (see `.claude/rules/ui-components.md`).

## Files to touch
- `src/components/phone/NewAgent/PhoneNewAgentComposer.tsx` (+ `.module.css`) — new
- `src/components/phone/NewAgent/useNewAgentSend.ts` — new
- `src/components/phone/PhoneEmptyWorkspace.tsx` — thin wrapper
- `src/components/phone/PhoneEmptyWorkspace.module.css` — move styles as needed
- `src/App.tsx` — handleNewAgent on phone, composer surface render
- tests
