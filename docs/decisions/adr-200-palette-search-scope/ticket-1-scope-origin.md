---
title: Palette origin and scope resolution
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Palette origin and scope resolution

Add the notion of *where the palette was opened from* and a pure helper that
turns it into a scoped project id. No UI change yet.

1. In `src/components/command-palette/types.ts`, add
   `export type PaletteOrigin = "shortcut" | "search";` and an optional
   `origin?: PaletteOrigin` on `CommandPaletteProps` (default `"shortcut"`).
2. Create `src/components/command-palette/scope.ts` with:
   ```ts
   export function resolvePaletteScope(args: {
     origin: PaletteOrigin;
     activeSurface: AppSurface; // from store/app-store
     activeWorkspacePath: string | null;
     projects: ProjectInfo[];
   }): string | null
   ```
   Rules: `"search"` → `null`. `"shortcut"` → the id of the project whose
   `workspaces` contain `activeWorkspacePath`, but only when
   `activeSurface === "workspace"` and `!isHomePath(activeWorkspacePath)`
   (`src/lib/home-path`). Otherwise `null`.
3. Unit tests in `src/components/command-palette/__tests__/scope.test.ts`
   (vitest, matching other tests under `src/**/__tests__`): search origin,
   shortcut in a workspace, shortcut on home, shortcut on tasks/projects
   surfaces, unknown workspace path.
4. In `src/App.tsx`, add `const [paletteOrigin, setPaletteOrigin] =
   useState<PaletteOrigin>("shortcut")`. `openPalette` (used by
   `Sidebar`/`SidebarRail` `onOpenSearch`) becomes
   `() => { setPaletteOrigin("search"); setPaletteOpen(true); }`.
   `togglePalette` and `handleOpenPaletteView` set `"shortcut"` when opening.
   Pass `origin={paletteOrigin}` to `<CommandPalette>`. Check other callers
   of `openPalette` and keep their meaning (anything that isn't the sidebar
   Search row is `"shortcut"`).

Do not change `CommandPalette.tsx` beyond accepting the prop (ticket 2 uses
it).

## Files to touch
- `src/components/command-palette/types.ts` — `PaletteOrigin`, `origin` prop
- `src/components/command-palette/scope.ts` — new, `resolvePaletteScope`
- `src/components/command-palette/__tests__/scope.test.ts` — new
- `src/App.tsx` — origin state, pass to palette
