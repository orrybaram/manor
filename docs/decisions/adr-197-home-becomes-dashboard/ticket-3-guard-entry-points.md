---
title: Hide or disable tab and agent entry points on the Dashboard
status: in-progress
priority: high
assignee: sonnet
blocked_by: [2]
---

# Hide or disable tab and agent entry points on the Dashboard

ADR-197 §3. The store already no-ops on Home (ticket 1); this ticket makes the UI honest so nothing offers an action that does nothing.

## Changes
- `src/lib/keybinding-commands.ts`: add an `unlessHome` guard next to `unlessOverviewShown` (~:117) and apply it to `new-tab`, `new-agent`, `new-browser` (~:130–132), `split-h`/`split-v` (~:133–134), `reopen-pane` (~:136), `split-panel-*` (~:162–163), `open-diff` (~:215–220).
- Command palette, hide when Home is active:
  - `src/components/command-palette/useCommands.tsx`: new-tab/new-browser (~:93–108), split-h/v (~:169–185), split-with (~:189–226), convert-to (~:231–266), split-panel (~:273–290), open-diff (~:352–366), open-port-in-browser (~:396–404).
  - `src/components/command-palette/useAgentCommands.tsx` ~:40–47 "New Agent".
  - `IssueDetailView.tsx` ~:61–66 and `GitHubIssueDetailView.tsx` ~:66–69: hide "New Agent" on Home (the "start work → new workspace" path stays).
- Native menu:
  - `src/lib/menu-commands.ts`: add `canCreateTabs: boolean` to `MenuContext` (~:152).
  - `src/hooks/useMenuContextSync.ts` ~:105–126: `canCreateTabs = !!activeWorkspacePath && !isHome` (and false when the Projects overview is shown, if the context knows that).
  - `electron/app-menu-template.ts`: `enabled: canCreateTabs` on New Agent/Tab/Browser (~:131–133), Open Diff (~:137), Reopen Closed Pane (~:152), Agents › New Agent (~:361); make `hasSurface` (~:96) false on Home so pane items (~:306–339) disable.
  - `src/lib/menu-handlers.ts`: `open-in-editor`, `reveal-in-finder`, `copy-workspace-path` (~:223–243) must no-op on Home (they'd act on the literal `"__home__"`); disable them in the menu via `hasWorkspace` if not already.
- `src/components/ports/PortBadge.tsx` ~:42: hide "open in tab" when Home is active.

## Tests
Update `src/lib/__tests__/keybinding-commands.test.ts`, `src/lib/__tests__/menu-handlers.test.ts`, `src/hooks/__tests__/useMenuContextSync.test.ts`, `electron/app-menu-template.test.ts`, `tests/e2e/app-menu.spec.ts` ("items disabled on Home"). Run typecheck and affected tests.

## Files to touch
- `src/lib/keybinding-commands.ts`
- `src/components/command-palette/useCommands.tsx`
- `src/components/command-palette/useAgentCommands.tsx`
- `src/components/command-palette/IssueDetailView.tsx` (locate exact path)
- `src/components/command-palette/GitHubIssueDetailView.tsx` (locate exact path)
- `src/lib/menu-commands.ts`
- `src/hooks/useMenuContextSync.ts`
- `electron/app-menu-template.ts`
- `src/lib/menu-handlers.ts`
- `src/components/ports/PortBadge.tsx`
- related tests
