---
title: Harness abstraction + global orchestrator preferences + settings UI
status: in-progress
priority: critical
assignee: sonnet
blocked_by: []
---

# Harness abstraction + global orchestrator preferences + settings UI

Establish the agent-agnostic harness backbone that the orchestrator surface
(ticket 4) and `send_to_session` (ticket 3) both depend on. No orchestrator
surface yet — just config, the adapter, and settings UI.

## What to build

1. **Renderer harness adapter** — `src/lib/harness.ts`:
   - `type HarnessKind = "claude" | "codex" | "custom"`.
   - `interface HarnessAdapter { kind; launchCommand(): string; interruptSequence(): string; isIdle(status: string | null): boolean; }`
   - Built-in adapters for `claude` and `codex`. `claude.interruptSequence()`
     returns `"\x1b"` (Esc); `codex.interruptSequence()` returns `"\x03"`
     (Ctrl-C). `launchCommand()` for claude ≈ `DEFAULT_AGENT_COMMAND`
     (`src/agent-defaults.ts`); codex ≈ `"codex"` (match `getAgentKindForCommand`
     token expectations). `isIdle(status)` is true for
     `requires_input | responded | complete | idle` and false for
     `thinking | working`.
   - `resolveOrchestratorAdapter(prefs): HarnessAdapter` — reads the new
     preferences; for `custom`, builds an adapter from
     `orchestratorCustomCommand` + `orchestratorCustomInterrupt`.
   - Keep this module importable by the renderer only (no electron imports).

2. **Main-side interrupt map** — `electron/harness-interrupt.ts`:
   - `interruptSequenceFor(agentKind: string, custom?: string): string` keyed by
     `agentKind` (`claude` → `"\x1b"`, `codex`/`opencode`/`pi` → `"\x03"`,
     `custom` → provided string, default `"\x03"`). Standalone, no `src/` import
     (respects the electron tsconfig boundary). Ticket 3 uses this.

3. **Preferences** — add to `AppPreferences` (`src/electron.d.ts:3-19`) and
   `defaultPreferences` (`src/store/preferences-store.ts:13-27`):
   - `orchestratorHarness: HarnessKind` (default `"claude"`)
   - `orchestratorCustomCommand: string` (default `""`)
   - `orchestratorCustomInterrupt: string` (default `""`)
   - If the main-process preferences handler validates/whitelists keys, add these
     there too so `preferences.set` persists them.

4. **Settings UI** — new `src/components/settings/OrchestratorSettingsPage.tsx`,
   mirroring `GeneralSettingsPage.tsx` (`usePreferencesStore()`, `set(key, val)`):
   - A select for harness (`claude | codex | custom`).
   - When `custom`, show `Input`s for launch command + interrupt sequence.
   - Register in `SettingsModal.tsx`: add `{ type: "orchestrator" }` to the
     `SettingsPage` union, a nav button, and a render branch.
   - Use `ui/` components per `.claude/rules/ui-components.md` (Button, Input,
     Switch, etc.) — no raw `<button>`.

## Files to touch
- `src/lib/harness.ts` — NEW renderer adapter + `resolveOrchestratorAdapter`.
- `electron/harness-interrupt.ts` — NEW main-side interrupt map.
- `src/electron.d.ts` — extend `AppPreferences` (~lines 3-19).
- `src/store/preferences-store.ts` — extend `defaultPreferences` (~lines 13-27).
- `src/components/settings/OrchestratorSettingsPage.tsx` — NEW settings page.
- `src/components/settings/SettingsModal/SettingsModal.tsx` — register page (union ~27-33, nav ~90-128, render ~164-170).
- Main preferences handler (whichever `electron/` file backs `window.electronAPI.preferences`) — allow the new keys if key-whitelisted.
