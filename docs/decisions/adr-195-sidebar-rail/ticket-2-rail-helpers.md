---
title: Pure rail helpers and shared workspace display name
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Pure rail helpers and shared workspace display name

See ADR-195 §3 (`docs/decisions/adr-195-sidebar-rail/index.md`).

1. Create `src/lib/sidebar-rail.ts`:
   - `railTileLabel(name: string): string`. If the trimmed name starts with an emoji (use `Intl.Segmenter` to get the first grapheme, and `/\p{Extended_Pictographic}/u` to test it), return that grapheme. Otherwise return the first letter or digit, uppercased. Return `"?"` for an empty name.
   - `railWorkspaceRows(entry: TopLevelEntry): RailRow[]` with
     ```ts
     type RailRow =
       | { kind: "host"; hostId: string | null }
       | { kind: "folder"; key: string; name: string; depth: number }
       | { kind: "workspace"; project: ProjectInfo; ws: WorkspaceInfo };
     ```
     For a `project` entry, flatten `buildSidebarItems({ workspaces, folders, sidebarOrder })` (from `src/utils/sidebar-items.ts`) in tree order. For a `group` entry, emit a `host` row per section (from `section.project.hostId`) followed by that section's rows. Skip `ws.hidden`. Skip folders with no visible workspace anywhere under them. `depth` is the folder nesting level, starting at 0.
2. Pull the display-name logic out of `ProjectItem.tsx` (around line 706: `ws.isMain ? ws.name || remoteTarget || "local" : ws.name || ws.branch || "main"`) into an exported `workspaceDisplayName(ws, remoteTarget)` in the same new file, and use it from `ProjectItem.tsx`. Make sure `remoteTarget` is computed in a way the rail can reproduce. If it comes from the project or host, add a small exported helper for that as well.
3. Unit tests in `src/lib/__tests__/sidebar-rail.test.ts`:
   - labels: letter, lowercase, emoji, leading whitespace, empty
   - rows: a flat project, nested folders, a hidden workspace, an empty folder skipped, a linked group with two host sections

## Files to touch
- `src/lib/sidebar-rail.ts` — new
- `src/lib/__tests__/sidebar-rail.test.ts` — new
- `src/components/sidebar/ProjectItem.tsx` — use `workspaceDisplayName`
