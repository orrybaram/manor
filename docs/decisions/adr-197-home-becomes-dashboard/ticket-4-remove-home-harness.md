---
title: Delete the home harness and its settings page
status: done
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Delete the home harness and its settings page

ADR-197 §4.

## Changes
- Preferences: remove `homeHarness`, `homeCustomCommand`, `homeCustomInterrupt` from `src/store/preferences-store.ts` (~:29–31), `src/electron.d.ts` (~:34–38), `electron/preferences.ts` (~:36–40, ~:60–62). Make sure loading a prefs file that still contains these keys doesn't error (strip or ignore).
- `src/lib/harness.ts` ~:76–95: delete `HomeHarnessPreferences` and `resolveHomeAdapter`. Keep `adapterForKind` and adapters (used by `ReviewBar.tsx`, `review-submit.ts`).
- `src/lib/home.ts`: delete `homeLaunchCommand` and the harness import; keep `HOME_PATH`/`isHomePath` re-exports and `escapeShellDoubleQuoted` (used by `agent-prompt-launch.ts`). Update the file comment (no more cwd/harness).
- Remove Home branches: `src/agent-defaults.ts` ~:43–50 (`getAgentCommand`), `src/lib/keybinding-commands.ts` ~:73–86 (`resolveWorkspaceCommand`), `src/hooks/useTerminalLifecycle.ts` (~:23, :26, :345–350, :359–362, :389–398), `src/lib/agent-context-repair.ts` ~:66–67 (orphaned Home agents: skip them instead of assigning a Home context), `src/App.tsx` ~:406–424 (home harness prefs reads; `activeWorkspaceCommand` only uses the project's command).
- Settings: delete `src/components/settings/HomeSettingsPage.tsx`; remove its import/nav item/page render from `src/components/settings/SettingsModal/SettingsModal.tsx` (~:25, ~:396–404, ~:493); remove `"home"` from `SettingsPageId` and its search entry in `settings-search.ts` (~:9, ~:130–142); remove "Settings: Home" command in `useCommands.tsx` (~:666–682). Grep for any other `"home"` settings page references (e.g. `handleOpenSettings("home")`).
- Update tests: `settings-search.test.ts`, `agent-context-repair.test.ts`, `keybinding-commands.test.ts`, `src/hooks/__tests__/paneCreateHostId.test.ts`, any harness tests.

Grep afterwards for `homeHarness|homeCustom|resolveHomeAdapter|homeLaunchCommand|HomeSettingsPage` — zero hits in src/ and electron/. Run typecheck and affected tests.

## Files to touch
- `src/store/preferences-store.ts`, `src/electron.d.ts`, `electron/preferences.ts`
- `src/lib/harness.ts`, `src/lib/home.ts`
- `src/agent-defaults.ts`, `src/lib/keybinding-commands.ts`, `src/hooks/useTerminalLifecycle.ts`, `src/lib/agent-context-repair.ts`, `src/App.tsx`
- `src/components/settings/HomeSettingsPage.tsx` (delete), `SettingsModal.tsx`, `settings-search.ts`
- `src/components/command-palette/useCommands.tsx`
- related tests
