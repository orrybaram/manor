---
title: Hosts section with per-host rows; one project page
status: todo
priority: critical
assignee: opus
blocked_by: [2, 3, 4]
---

# Hosts section with per-host rows; one project page

ADR-237 D2 and D3. Read the ADR's Decision section first. This ticket
replaces three section components with one and merges the three project
page components into one.

## 1. `ProjectHostsSection`

New `src/components/settings/ProjectHostsSection/ProjectHostsSection.tsx`,
props `{ project: ProjectInfo; members: ProjectInfo[] }` (`members` is
`[project]` for a lone project, the group's members in `memberIds` order
otherwise; the caller guarantees at least one).

Layout, top to bottom:

- `<div className={styles.sectionHeader}>` holding
  `<SectionTitle id="project-host">Hosts</SectionTitle>` and the **Set up
  on…** `SearchableSelect` (`value=""`, `placeholder="Set up on…"`,
  `data-testid="project-host-select"`, `maxWidth={200}`). Its options,
  `ADD_HOST_VALUE`, `showAllHosts`, `hiddenPods`, `adding`, `handleSelect`
  and `handleAdded` move over from
  `src/components/settings/ProjectHostSection/ProjectHostSection.tsx`
  unchanged (`transferTargets(project, projects, hosts, "copy", { showAllHosts })`
  filtered to enabled targets, plus "Add new host…"; `setUpOnHost`).
- `<div className={styles.fieldHint}>Where this project is set up. Each host keeps its own path, worktrees and ports.</div>`
  — the first sentence is matched by `tests/e2e/set-up-on-host.spec.ts`;
  keep it verbatim.
- `<div className={hostStyles.hostList}>` (from
  `../HostsPage/HostsPage.module.css`) of one `ProjectHostRow` per member,
  `defaultOpen={members.length === 1}`.
- The "Show all hosts" / "Hide other projects' hosts" link button when
  `hiddenPods`, and `<AddSshHostForm>` when `adding`, as today.
- When `members.length > 1`: a ghost `Button` "Keep separate…" and the
  `ConfirmDialog` moved from `src/components/settings/ProjectSetUpOnSection.tsx`
  (`keepSeparate(project.id)`; the description names
  `project.group?.name ?? project.name`).

## 2. `ProjectHostRow`

New `src/components/settings/ProjectHostsSection/ProjectHostRow.tsx`, props
`{ member: ProjectInfo; memberCount: number; defaultOpen: boolean }`.

Header, through `HostRowShell` (`../HostsPage/HostRow`):

- `sectionId={`project-host-${member.id}`}`, `testId="project-host-row"`,
  `hostId={member.hostId}`, `defaultOpen`.
- `name`: `useMemberDisplayName(member.hostId, hosts)` from
  `src/bridge/server-set.ts` (what `MemberSettingsPage` used).
- `display = useHostDisplay(member.hostId)`;
  `{ word, tone } = projectHostStatus(member.hostId, display)` (ticket 4).
  `icon`: `<Laptop size={15} />` for a local host, else
  `<HostStateIcon display={display ?? pendingDisplay(member.hostId)} size={15} />`.
  `tone={tone}`, `status={word}`.
- `detail={member.path}` with `title={member.path}` on a wrapping span.

Body (children), in order, each a `Stack gap="xs"` with `styles.fieldLabel`
labels as the old sections had:

1. Default branch: `<div className={styles.fieldStatic}>{member.defaultBranch}</div>`.
2. Worktree path input + hint, Start script and Teardown script textareas:
   move `WorktreesSection`, `worktreeScriptFields` and `defaultWorktreePath`
   from `ProjectSettingsPage.tsx` (the `saveField` closure writes through
   `updateProject(member.id, …)`). Drop the inner `SectionTitle`.
3. Named preview URLs `SettingRow` + `Switch`: move `PortsSection` and
   `previewHostname` from `ProjectSettingsPage.tsx`. Drop its `SectionTitle`.
4. Missing-repo repair: move the `pathMissing` effect, `repairError`,
   `cloneAgain` and `pointAtAnotherFolder` from `ProjectHostSection.tsx`.
   Render the warning as
   `<div className={styles.remoteWarning}><ShieldAlert size={14} /><span>Repository not found on this host</span>…buttons…</div>`
   (the class `HostRow.tsx` uses for key warnings), and the error as
   `<div className={styles.linearError}>`. `HostCardRow` is not used.

Footer (`footer` prop):

- `<Button variant="link" onClick={() => goTo({ type: "hosts" }, hostSection)}>Open {name} in Hosts</Button>`
  where `goTo = useSettingsNav()` and `hostSection` is
  `isRemoteHost(member.hostId) ? `host-${member.hostId}` : LOCAL_HOST_SECTION`
  (export the constant from `../HostsPage/ThisMacRow.tsx` if it is not
  exported; it is the `sectionId` `ThisMacRow` passes, `"host-local"`).
- `<span className={hostStyles.spacer} />`.
- When `memberCount > 1`: ghost `Button` "Remove from {name}" →
  `openRemoveFromHost(member.id)`.

## 3. One `ProjectSettingsPage`

In `src/components/settings/ProjectSettingsPage.tsx`:

- Delete `PathFields`, `PortsSection`, `WorktreesSection`,
  `previewHostname`, `defaultWorktreePath`, `worktreeScriptFields`,
  `GroupSettingsPage`, `MemberSettingsPage`, and the imports they alone
  used (`Cloud`, `Laptop`, `useMemberDisplayName`, `isRemoteHost`, the
  portless helpers, `Switch`, `SettingRow`, `ProjectGroupInfo`,
  `ProjectHostSection`, `ProjectSetUpOnSection`).
- The one export:
  ```tsx
  type ProjectSettingsPageProps = { lead: ProjectInfo; members: ProjectInfo[] };
  export function ProjectSettingsPage({ lead, members }) {
    return (
      <Stack className={styles.pageContent}>
        <Stack gap="xs">
          <SectionTitle id="project-general">General</SectionTitle>
          <div className={styles.generalGrid}>
            <NameField key={lead.group?.name ?? lead.name} project={lead} />
            <ProjectThemeSelector project={lead} />
          </div>
          <ColorField project={lead} />
        </Stack>
        <LinearProjectSection project={lead} />
        <ProjectHostsSection project={lead} members={members} />
        <AgentSection project={lead} />
        <CommandsSection project={lead} />
      </Stack>
    );
  }
  ```
  Keep the comment from `GroupSettingsPage` explaining that a group's
  shared fields read and write through the lead member, and that the name
  field is keyed by the group's name so a rename made elsewhere shows.
- `src/components/settings/SettingsModal/SettingsModal.tsx`: import only
  `ProjectSettingsPage`; render the group page as
  `<ProjectSettingsPage key={currentGroup.id} lead={currentGroupMembers[0]} members={currentGroupMembers} />`
  (guard `currentGroupMembers.length > 0`) and the project page as
  `<ProjectSettingsPage key={currentProject.id} lead={currentProject} members={[currentProject]} />`.

## 4. Delete

- `src/components/settings/ProjectHostSection/` (the whole folder).
- `src/components/settings/ProjectSetUpOnSection.tsx`.

`pnpm test` runs `knip`, so an orphaned file or export fails; delete in
the same commit. `HostCard` becomes unused here but ticket 7 removes it;
if `knip` flags it as unused after this ticket, leave the flag for ticket 7
and say so in your report.

## 5. CSS

`src/components/settings/SettingsModal/SettingsModal.module.css`:

```css
/* A section title with a control on its right (ADR-237 D3). */
.sectionHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sectionHeader .sectionTitle {
  margin-bottom: 0;
}
```

## Files to touch
- `src/components/settings/ProjectHostsSection/ProjectHostsSection.tsx` — new
- `src/components/settings/ProjectHostsSection/ProjectHostRow.tsx` — new
- `src/components/settings/ProjectSettingsPage.tsx` — one page component; sections removed
- `src/components/settings/SettingsModal/SettingsModal.tsx` — render the one page for both kinds
- `src/components/settings/SettingsModal/SettingsModal.module.css` — `.sectionHeader`
- `src/components/settings/HostsPage/ThisMacRow.tsx` — export the local section id if needed
- `src/components/settings/ProjectHostSection/ProjectHostSection.tsx` — delete
- `src/components/settings/ProjectSetUpOnSection.tsx` — delete

## Acceptance
- `pnpm typecheck`, `pnpm test:unit` pass; `npx knip --include files,dependencies,unlisted,binaries` reports nothing new except `HostCard` (ticket 7).
- A lone project's page shows one host row, open. A project on two hosts shows two rows, closed, with "Remove from <host>" in each row's footer and "Keep separate…" under the list.
