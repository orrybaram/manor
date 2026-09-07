---
title: Docs and integration check for the completed control surface
status: in-progress
priority: low
assignee: haiku
blocked_by: [2, 3, 4, 5, 6]
---

# Docs and integration check for the completed control surface

1. Run `node dist-electron/manor-cli.js --help` after `pnpm build` and paste the full command list into `docs/AGENT-SYSTEM.md` §10.4 as a collapsed `<details>` block, replacing any stale count.
2. `README.md` "Agent CLI": update the example set to show one folder command (`manor create-folder --name Backlog`) and one git command.
3. `docs/ARCHITECTURE.md` file tree: add `routes/folders.ts`, `routes/git.ts`, `routes/system.ts`, `routes/integrations.ts`, `process-control.ts`, `editor.ts`, `mcp/tools-git.ts`, `mcp/tools-system.ts`.
4. Link ADR-171 from §10.4.
5. Run `pnpm test`, `pnpm lint`, `pnpm build`; report counts.

## Files to touch
- `docs/AGENT-SYSTEM.md`
- `README.md`
- `docs/ARCHITECTURE.md`
