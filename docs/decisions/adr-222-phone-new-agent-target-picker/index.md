---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-222: Phone new-agent composer picks host, project and workspace

## Context

On a phone, every "New agent" entry point (the drawer's `+ New agent` pill and
its empty-state button in `PhoneAgentsPanel`, the TabBar `+`, and the palette)
calls `App.tsx` `handleNewAgent`. That calls `startNewAgent`
(`src/lib/keybinding-commands.ts:102`), which opens a blank agent tab **in the
active workspace** straight away. To start an agent somewhere else, you first
navigate the drawer's Projects view to that workspace. You cannot create a
worktree from the phone at all, except through the desk-styled
`NewWorkspaceDialog`.

The phone already has a composer-first screen, `PhoneEmptyWorkspace` (from
ADR-181 follow-ups). There the first message is the agent's prompt and nothing
launches until it is sent. But it only appears when the active panel has no
tabs, and it is locked to the active workspace.

The Claude app's new-session composer shows chips above the input:
`Local` (host) · `homebook` (project) · `main ☑ worktree` (branch plus a
worktree toggle). The user wants the same pattern on the phone:

- "New agent" opens a composer rather than launching.
- Chips pick the **host** (only when the project is linked across hosts,
  ADR-192/193), the **project**, and the **workspace** (main or an existing
  workspace), plus a **new worktree** toggle that creates a fresh workspace
  on send.
- The agent launches only on the first message.

## Decision

### D1. A `"composer"` app surface

`AppSurface` (`src/store/app-store.ts:83`) gains `"composer"`.

- New actions: `showComposer()` and `closeComposer()`. The latter goes back to
  `"workspace"`.
- In `App.tsx`, the `.empty-surface` branch renders the composer when
  `activeSurface === "composer"`, even when the active workspace has tabs.
  `WorkspaceStack` gets `visibleKey = null` while the composer is up, the same
  way it does for the tasks view.
- On phone, `handleNewAgent` calls `showComposer()` instead of `startNewAgent`.
  The desk behavior is unchanged.
- Selecting a workspace, tab or agent from the drawer (anything that calls
  `setActiveWorkspace` or `selectTab`) resets the surface to `"workspace"`,
  as it already does for tasks (`app-store.ts:1031`).

### D2. A pure target model

New file `src/components/phone/NewAgent/new-agent-target.ts`. It has no React
and no stores.

```ts
type NewAgentTarget = {
  projectId: string;                  // the member project (one per host)
  workspacePath: string;              // project.path for main
  newWorktree: boolean;
};
seedTarget(projects, activeKey, hosts): NewAgentTarget | null
projectChoices(projects): { id, name, color, groupId? }[]   // groups collapsed via buildTopLevelEntries
hostChoices(target, projects, hosts): WorkspaceHostChoice[] | null  // workspaceHostChoices; null = hide chip
workspaceChoices(target, projects): { path, label, branch, isMain }[]  // main first, hidden workspaces dropped
selectProject(target, projectOrGroupId, projects, hosts): NewAgentTarget // group → startingMemberId; workspace → main
selectHost(target, memberProjectId, projects): NewAgentTarget            // keeps the workspace if one of the same branch exists there, else main
selectWorkspace(target, path): NewAgentTarget
```

Seeding works like this:

- When the active workspace belongs to a project, use that project and
  workspace, with `newWorktree: false`.
- On Home, or with no workspace, use the first top-level entry, with groups
  resolved through `startingMemberId`.
- With no projects at all, the result is `null`, and the composer shows the
  existing no-projects empty state.

### D3. Worktree names come from the prompt

New `worktreeNameFromPrompt(prompt, takenNames)` in `src/utils/branch-name.ts`.

- It takes `toDirSlug` of the prompt's first ~6 words and caps the result at
  40 characters.
- It falls back to `agent` when the slug is empty.
- It adds a `-2`, `-3`, … suffix until the name doesn't collide with an
  existing workspace name, worktree branch or local branch in the project,
  compared case-insensitively (local branches from `listLocalBranches`; a
  collision would otherwise make `git worktree add -b` fall back to checking
  out the old branch).

The name is already a valid ref, so no separate `branch` is passed; the main
process sanitizes `branch || name` itself. The base comes from one pure
`baseBranchOf(resolved)` in `new-agent-target.ts`, used by both the greeting
and the send: for main it is `project.defaultBranch || "main"`, as in
`NewWorkspaceDialog`, so main uses the local default branch; otherwise it is
the workspace's branch, or undefined (so `origin/<default>` applies) for a
detached HEAD.
In other words, "existing workspace + new worktree" means "branch off that
workspace". This matches the Claude chip, where the branch chip picks the base.

### D4. `createWorktree` reports the agent's pane

`CreateWorktreeOptions` (`project-store.ts:507`) gains
`onAgentPane?: (paneId: string) => void`. It is called with the pane id of the
`agent-startup` tab that `createWorktree` opens when `agentPrompt` is set. The
phone uses it for `markChatStarting` (ADR-215 D7). The return type does not
change, so other callers are untouched.

### D5. Composer UI: `PhoneNewAgentComposer`

New file `src/components/phone/NewAgent/PhoneNewAgentComposer.tsx` (plus
`.module.css`). It absorbs `PhoneEmptyWorkspace`'s greeting, recents rail and
composer.

- **One component for both surfaces.** `PhoneEmptyWorkspace` is inlined into
  `WorkspaceEmptyState`, and the empty-workspace screen gets the chips too.
  The empty screen keeps its target pick in local state; only the
  `"composer"` surface reads and writes `composerDraft.target`.
- **Chip row.** It sits directly above the textarea, scrolls sideways, and
  has the `data-keyboard-lift` container, laid out as:
  `[host]` `[📁 project]` `[⑂ workspace │ ☐ worktree]`.
  - The host chip renders only when `hostChoices` returns non-null. Its label
    comes from `memberHostName` ("This machine" / ssh target), with the
    `HostIndicator` icon.
  - The worktree toggle is a `Checkbox` inside the workspace chip, as in the
    screenshot.
- **Choice lists.** Tapping a chip opens an inline choice list above the
  composer, in the `CommandChoiceSheet` pattern: a backdrop plus a list, with
  focus kept in the textarea so the soft keyboard stays up. Disabled host
  choices show their `disabledReason`. The project list shows the project
  color dot, and the workspace list shows name and branch.
- **Greeting.** The greeting subline follows the target, not the active
  workspace: "Claude is ready in `<workspace>` on `<branch>`". With the
  worktree toggle on, it reads "Claude will start a new worktree off
  `<branch>`".
- **Recents.** The recents rail follows the target workspace.
- **Close button.** When opened as the `"composer"` surface, the top bar
  shows a close (×) `Button` that calls `closeComposer()`. As the plain empty
  workspace there is nothing to close back to, so the button is hidden.
- **Interactive elements.** All of them use `ui/` components: `Button`,
  `Checkbox`, `EmojiTextarea`.

### D6. Send

A plain function `sendNewAgent(prompt, target)` (`send-new-agent.ts`, same
folder) handles sending. ⌘N and "New agent" go through one `newAgent()` in
`keybinding-commands.ts`, which opens the composer on a phone.

- **Existing workspace or main:**
  1. `launchAgentInWorkspace(workspacePath, { prompt, hostId: project.hostId })`.
  2. `markChatStarting(paneId)` for a Claude agent kind.
  3. If the project is in a group, `setGroupLastUsedHost(group.id, hostId)`.
  4. Clear the draft, only once a tab opened. Opening the tab already leaves
     the composer surface (`leaveTasksView()`).
- **New worktree:**
  1. `createWorktree(projectId, name, { branch, baseBranch, agentPrompt: prompt, onAgentPane: markChatStarting })`.
     The worktree setup view and toast already cover progress. Main records
     the last-used host (ADR-203).
  2. `closeComposer()` immediately, so the user lands on the new workspace's
     setup view and then the agent's chat.
  3. On failure (`null`), the existing error toast fires. The draft text is
     kept, because the composer state lives in the store: see the next point.
- **Draft persistence.** The draft text and the target are stored as
  `composerDraft` on the app store, so closing and reopening, or a failed
  worktree, doesn't lose them. Both are cleared on a successful send. They
  are not persisted to disk.

## Consequences

**Better:**

- Starting an agent anywhere takes one screen: no drawer navigation first,
  and no accidental blank agents from a stray `+` tap.
- Worktrees can be created from the phone with zero typing beyond the prompt.
- The empty workspace and "New agent" share one composer, so the two
  surfaces can't drift.

**Harder or riskier:**

- **Behavior change for blank agents.** "New agent" on phone no longer
  launches a blank agent, so a user who wants an empty session must type
  something. This matches the existing empty-workspace behavior, and
  terminals are still available from the TabBar `+` context menu.
- **A third surface value.** Every place that branches on `activeSurface`
  must handle `"composer"`, though most only check `=== "tasks"` or
  `!== "workspace"`. Ticket 1 audits them.
- **Prompt-derived worktree names** can be clumsy. Renaming already exists
  (`RenameDialog`), and branch names stay sanitized.
- **The phone is always cold-start,** because there is no prewarm on web, so
  there's no regression from bypassing `startNewAgent`.
- **Remote hosts** go through the same `createWorktree` IPC, which routes via
  `ctx.host(project.hostId)` and is allowed over the web bridge.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
