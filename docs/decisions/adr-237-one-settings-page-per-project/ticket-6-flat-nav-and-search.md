---
title: Flat project nav, deep-link jump id, search index rewrite
status: todo
priority: critical
assignee: opus
blocked_by: [5]
---

# Flat project nav, deep-link jump id, search index rewrite

ADR-237 D1 and D5.

## `settings-search.ts`

`src/components/settings/SettingsModal/settings-search.ts`:

1. `PROJECT_SECTIONS` becomes, in page order:
   - `project-general` "General", keywords `name, color, theme`
   - `project-linear` "Linear" (unchanged)
   - `project-host` "Hosts", keywords `host, hosts, remote, ssh, machine, server, set up, remove, separate, worktree, branch, path, folder, port, portless, preview, proxy, hostname, url`
   - `project-agent` "Agent" (unchanged)
   - `project-commands` "Commands" (unchanged)

   `project-ports`, `project-worktrees`, `project-links`,
   `project-location` are gone.
2. Delete `MACHINE_SECTION_IDS`, `sectionById`, `projectSection`,
   `GROUP_SECTIONS`, `MEMBER_SECTIONS`.
3. `SettingsProjectEntry` becomes `{ kind: "project" | "group"; id: string; name: string }`.
4. `buildSettingsIndex`'s per-project part: for each entry,
   `pageEntries(entry.name, entry.kind === "group" ? { type: "group", groupId: entry.id } : { type: "project", projectId: entry.id }, PROJECT_SECTIONS)`.
5. Update the `SettingsPage` doc comment: a group page is a project set up
   on several hosts; both kinds render the same page (ADR-237 D1).
6. Add and export:
   ```ts
   /**
    * The section a project deep link scrolls to (ADR-237 D5). A member's
    * host link lands on that member's row of the Hosts section, so the row
    * opens; everything else names the section itself.
    */
   export function projectJumpId(
     section: string | null | undefined,
     projectId: string,
     grouped: boolean,
   ): string | null {
     if (!section) return null;
     if (section === "project-host" && grouped) return `project-host-${projectId}`;
     return section;
   }
   ```

## `SettingsModal.tsx`

`src/components/settings/SettingsModal/SettingsModal.tsx`:

1. `pageForProject(project, projectId)` drops its `section` parameter and
   `MACHINE_SECTION_IDS`: a grouped project opens its group page, else its
   own.
2. In the open-transition block, after `setPage(...)` for
   `initialProjectId`, compute the jump with
   `projectJumpId(initialSection, initialProjectId, project?.group != null)`
   and pass it to `setPendingJump` (the existing
   `initialSection ? { id, nonce: 0 } : null` becomes
   `jumpId ? { id: jumpId, nonce: 0 } : null`; for a non-project open, the
   jump stays `initialSection`).
3. `navProjects`: entries are `{ kind, id, name }` only; drop `members`,
   the `hosts` store read, `serverHostName` and `memberHostName`.
4. The nav: remove the member-row block (the `entry.kind === "group" && entry.members.map(...)` part) and the `Fragment` wrapper; a project row is one `<button>` with `data-testid={`settings-nav-${entry.kind}-${entry.id}`}` as today.
5. Remove now-unused imports: `Fragment`, `HostIndicator`, `Laptop`,
   `isRemoteHost`, `memberHostName`, `useHostStore`, `serverHostName`.

`SettingsModal.module.css`: delete `.navItemNested2` and its `svg` rule.

## Tests

Rewrite `src/components/settings/SettingsModal/settings-search.test.ts`:

- Index built from `[{ kind: "project", id: "p1", name: "manor" }, { kind: "group", id: "g1", name: "retrograde" }]`.
- A lone project's page entries are
  `[null, "project-general", "project-linear", "project-host", "project-agent", "project-commands"]`.
- A group's page entries are the same ids, all with `pageLabel` `"retrograde"`.
- No entry has `page.type === "project"` with an id other than `"p1"`.
- `searchSettings(index, "worktree")` and `"port"` both return entries whose
  `id` is `project-host` (one per project), and `"keep separate"`
  (keyword `separate`) too.
- `projectJumpId("project-host", "m1", true) === "project-host-m1"`;
  `projectJumpId("project-host", "p1", false) === "project-host"`;
  `projectJumpId("project-agent", "m1", true) === "project-agent"`;
  `projectJumpId(null, "m1", true) === null`.
- Keep the existing tests for fixed pages and ranking that still hold.

## Files to touch
- `src/components/settings/SettingsModal/settings-search.ts` — sections, entry type, `projectJumpId`
- `src/components/settings/SettingsModal/settings-search.test.ts` — rewrite
- `src/components/settings/SettingsModal/SettingsModal.tsx` — flat nav, jump id, imports
- `src/components/settings/SettingsModal/SettingsModal.module.css` — drop `.navItemNested2`

## Acceptance
- `pnpm typecheck`, `pnpm test:unit` pass.
- The senders of `open-project-settings` with `section: "project-host"` (`src/components/hosts/HostPopover.tsx`, `src/components/hosts/HostIndicator.tsx`, `src/store/project-store.ts`) are unchanged and, for a member id, open the group's page with that member's row open and flashed.
