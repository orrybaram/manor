---
title: WorkspaceIndicatorDot component wired into ProjectItem
status: done
priority: high
assignee: sonnet
blocked_by: [2, 3]
---

# `WorkspaceIndicatorDot` component wired into `ProjectItem`

## New component

`src/components/sidebar/WorkspaceIndicatorDot.tsx`:

```tsx
type Props = { indicator: NonNullable<WorkspaceIndicator> };
export function WorkspaceIndicatorDot({ indicator }: Props)
```

- `thinking` → `<SpinnerLoader size="sidebar" variant="thinking" />`
- `working` → `<SpinnerLoader size="sidebar" variant="working" />`
- `needs_you` → `<span>` 8px circle, `background: var(--yellow, #eab308)`,
  title `"Needs your input"`. When `indicator.pulse` add the pulse + ping ring
  classes.
- `done_unread` → `<span>` 8px circle, `background: var(--green)`, title
  `"Agent responded"`, always pulse + ping ring.

Every rendered element carries `data-testid="workspace-indicator"`,
`data-kind={indicator.kind}`, `data-pulse={indicator.pulse ? "true" : "false"}`.

`src/components/sidebar/WorkspaceIndicatorDot.module.css`: copy the `.dot`
base, `pulse` and `ping` keyframes and the `::after` ring pattern from
`src/components/ui/AgentDot/AgentDot.module.css`. Do not import from
AgentDot's module; the two are meant to diverge. No `width: auto` overrides
are needed since there are no glyphs.

**Debounce thinking↔working** (ADR-015 still applies since both spinners
remain). Inside `WorkspaceIndicatorDot`, map `indicator.kind` back to an
`AgentStatus`-compatible value for the two spinner kinds and pass it through
`useDebouncedAgentStatus` from `src/hooks/useDebouncedAgentStatus.ts`; render
the debounced kind. Simplest: `const shown = useDebouncedAgentStatus(kind === "thinking" || kind === "working" ? kind : undefined) ?? kind` — the hook only
delays transitions between those two values and passes everything else through
immediately. Do not debounce `needs_you` / `done_unread`.

## Wire into ProjectItem

In `src/components/sidebar/ProjectItem.tsx`:

1. Import `toWorkspaceIndicator` from `../../lib/workspace-indicator` and the
   new component. Remove the `AgentDot` import if it becomes unused.
2. Workspace row (currently ~line 127): compute
   `const indicator = toWorkspaceIndicator(workspaceStatus, workspacePulse)` and
   render `indicator ? <WorkspaceIndicatorDot indicator={indicator} /> : ws.isMain ? <GitBranch size={12}/> : <FolderGit2 size={12}/>`.
3. Collapsed project header (currently ~line 314): same, using
   `projectStatus` / `projectPulse`; render nothing when the indicator is null
   (matches today).

Run `pnpm typecheck` and `pnpm test` (check `package.json` for exact script
names) and make them pass. `knip` runs as part of `pnpm test`; if it flags
`AgentDot` as unused, that is a bug in your change (it is still used by tabs),
so re-check imports rather than deleting it.

## Files to touch
- `src/components/sidebar/WorkspaceIndicatorDot.tsx` — new
- `src/components/sidebar/WorkspaceIndicatorDot.module.css` — new
- `src/components/sidebar/ProjectItem.tsx` — swap `AgentDot` for the new component in both slots
