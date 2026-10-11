---
title: Composer app surface and draft state
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Composer app surface and draft state

ADR-222 D1 + the draft half of D6. Store and routing only — no new UI yet.

1. `src/store/app-store.ts`
   - `AppSurface` becomes `"workspace" | "tasks" | "composer"`.
   - Add `showComposer(): void` (sets `activeSurface: "composer"`) and `closeComposer(): void` (back to `"workspace"`).
   - Add `composerDraft: { text: string; target: NewAgentTarget | null }` (initial `{ text: "", target: null }`) with `setComposerDraft(patch)` and `clearComposerDraft()`. Declare `NewAgentTarget` locally in a new `src/components/phone/NewAgent/new-agent-target.ts` as just the exported type for now (`{ projectId: string; workspacePath: string; newWorktree: boolean }`) — ticket 2 fills in the functions. Not persisted.
   - Anywhere that resets `"tasks"` back to the workspace surface on workspace/tab selection (e.g. around `app-store.ts:1031` and `WORKSPACE_SURFACE`) must also reset `"composer"`. Audit every `activeSurface` read in `src/` (`rtk proxy grep -rn activeSurface src`) and make each correct for `"composer"` (e.g. `App.tsx:209`, `:920` — a worktree created while the composer is up must NOT be treated as background).
2. `src/App.tsx`
   - `composerShown = useAppStore(s => s.activeSurface === "composer") && layoutMode === "phone"`.
   - While shown: `WorkspaceStack` gets `visibleKey = null`, and the `.empty-surface` overlay renders `<WorkspaceEmptyState …/>`'s phone composer path — for now render the existing `<PhoneEmptyWorkspace />` there (ticket 4 swaps it). Desk ignores the surface.
   - Do NOT change `handleNewAgent` yet.
3. Unit tests in `src/store/__tests__/` for showComposer/closeComposer, reset on `setActiveWorkspace`/`selectTab`, and draft set/clear.

## Files to touch
- `src/store/app-store.ts` — surface value, actions, draft state
- `src/components/phone/NewAgent/new-agent-target.ts` — type only
- `src/App.tsx` — render composer surface on phone
- any other `activeSurface` reader found in the audit
- `src/store/__tests__/app-store-composer-surface.test.ts` — new
