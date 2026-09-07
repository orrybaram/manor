---
title: Clear the 29 pre-existing eslint errors
status: done
priority: low
assignee: opus
blocked_by: []
---

# Clear the 29 pre-existing eslint errors

`pnpm lint` reports 29 errors, none from ADR-170. Fix them all so lint is a usable signal.

Categories from `npx eslint .`:
- `@typescript-eslint/no-unused-vars` ×14 — delete the unused import/variable. Where a symbol is intentionally exported-for-future, delete anyway; git has it.
- `prefer-const` ×5 in `src/store/app-store.ts` (`newPanels`).
- `no-useless-escape` in `src/terminal/file-link-provider.ts:20`.
- `@typescript-eslint/no-explicit-any` ×3 in `electron/preload.ts:145-146` — type the IPC listener signature properly (`unknown` / `IpcRendererEvent`).
- `preserve-caught-error` in `electron/backend/local-git.ts:70` — pass `{ cause }` (check the tsconfig target supports `ErrorOptions`; `electron/mcp/context.ts` shows the assignment workaround if not).
- `react-hooks/set-state-in-effect` ×5: `src/components/sidebar/ProjectItem.tsx:261`, `WorkspaceEmptyState.tsx:124`, `DiffPane/DiffPane.tsx:188,206,245`. Fix per React's guidance: derive during render, reset via `key`, or move the write into the event that caused it. Preserve behaviour exactly; read each effect's surrounding code and any tests before changing. Only if a case is genuinely a legitimate external-sync pattern, keep it with a one-line `// eslint-disable-next-line react-hooks/set-state-in-effect -- <why>` comment.

Do not fix warnings. Do not run prettier on files you did not otherwise change.

## Verification
- `pnpm lint` → 0 errors.
- `pnpm test:unit` → green.
- `npx tsc --noEmit -p tsconfig.electron.json` error count unchanged (13) and `npx tsc --noEmit -p tsconfig.json` unchanged.

## Files to touch
Exactly the files eslint lists; nothing else.
