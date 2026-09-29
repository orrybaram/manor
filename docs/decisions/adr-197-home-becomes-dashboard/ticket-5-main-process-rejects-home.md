---
title: Main process and control server reject Home as a pane target
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [4]
---

# Main process and control server reject Home as a pane target

ADR-197 §5.

## Changes
- `electron/paths.ts`: delete `homeWorkspaceDir()` (~:212–217); `resolveSpawnCwd` (~:226–228) no longer maps `__home__`.
- `electron/app-lifecycle.ts` ~:15, ~:539–541: stop creating `~/.manor/home`. Do NOT delete the directory.
- `electron/ipc/pty.ts` `validatePtyArgs` (~:53–58): reject a `__home__` cwd with an error. Check `updatePrewarmCwd` (~:240–253) ignores Home.
- `electron/prewarm-manager.ts` ~:109 comment cleanup.
- `src/lib/app-commands.ts` (control-server command table): `new-tab` (~:235–291), `split-pane` (~:186), `duplicate-tab` (~:404), `open-diff` (~:442), `start-agent` (~:604–625, remove the `isHomePath` bypass at ~:618) must return an error "The Dashboard can't host panes" when the target (explicit or defaulted to active) is Home. `set-active-workspace` to Home stays allowed.
- MCP/CLI (`electron/mcp/tools-agents.ts`, `electron/mcp/tools-panes.ts`, `electron/mcp/context.ts`): make sure the error surfaces cleanly; update any tool descriptions that mention Home/`__home__` as a valid launch target.
- Tests: `electron/__tests__/paths.test.ts`, `src/lib/__tests__/app-commands.test.ts`, `src/lib/__tests__/hosts.test.ts` if affected.

Run typecheck and affected tests.

## Files to touch
- `electron/paths.ts`, `electron/app-lifecycle.ts`, `electron/ipc/pty.ts`, `electron/prewarm-manager.ts`
- `src/lib/app-commands.ts`
- `electron/mcp/tools-agents.ts`, `electron/mcp/tools-panes.ts`, `electron/mcp/context.ts`
- related tests
