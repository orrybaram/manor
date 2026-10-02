---
title: TaskDetail component
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# TaskDetail component

ADR-207 §2. Build the component; do not wire it anywhere yet (tickets 3, 4).
Visual reference: comps "Palette — shared TaskDetail" and "Tasks view A" at
https://claude.ai/artifact/C4JgdwPaPuRcxbN3D1YcAf

## API

```ts
type TaskDetailProps = {
  taskRef: TaskRef;
  row?: TaskRow;              // present → Start is available
  mode: "default" | "linked";
  layout: "card" | "drawer";
  linkedTo?: string;          // workspace label, linked mode
  projectId?: string;         // linked mode: unlink target
  workspacePath?: string;
  onNewWorkspace: NewWorkspaceHandler;
  onNewAgentWithPrompt?: (prompt: string) => void;
  onDone: () => void;         // after an action that should close the host
};
```

## Behaviour

- `useQuery(trackerFor(ref.provider).detailQuery(ref))`. Loading → own skeleton; error → message + Retry `Button` + "Open in <tracker>" `Link` (port `GitHubIssueDetailError`).
- Header: tracker icon + `displayId`, status pill (reuse Tasks view tone classes), title.
- Meta: assignees (initial avatars like `TaskTableRow`), project dot + name, labels (colored), priority (reuse `PriorityIcon` — export it from `TaskTableRow.tsx` or move to its own file), milestone, nothing for absent fields.
- Body: markdown via the existing `stripMarkdown` approach (move it next to `extractImages` from ticket 1) + images through `ProxiedImage` (move from `IssueDetailView.tsx`; Linear images go through `linear.proxyImage`).
- Actions (`default`): **Start in new workspace** (primary; uses `useStartTask` when `row` is given), **New agent here** (only if `startHere` exists, `onNewAgentWithPrompt` given and active workspace is not Home — `isHomePath`), **Open in <tracker>** (`Link`). `linked`: "Linked to X", **Unlink**, **Close & Unlink**, Open. Errors → `addErrorToast`.
- Keys while mounted (port the `ready`-after-rAF guard from `IssueDetailView` so the Enter that opened it doesn't fire): ↵ Start, ⌘↵ New agent here, ⌘O open in tracker. Disabled in `linked` mode except ⌘O. Use `useMountEffect` + refs as today.
- `layout`: `card` = two-column body/meta like today's `.detailLayout`; `drawer` = single column, meta grid above body, sticky action bar.
- Only `src/components/ui/` components for interactive elements.

## Files to touch
- `src/components/tasks/TaskDetail/TaskDetail.tsx` (new)
- `src/components/tasks/TaskDetail/TaskDetail.module.css` (new) — port the `.detail*` styles from `CommandPalette.module.css`
- `src/components/tasks/TaskDetail/TaskDetailSkeleton.tsx` (new)
- `src/components/tasks/TaskDetail/ProxiedImage.tsx` (new, moved)
- `src/components/tasks/TaskTableRow.tsx` — export `PriorityIcon` (or move it)
- `src/lib/task-images.ts` — `stripMarkdown`
- `src/components/tasks/TaskDetail/TaskDetail.test.tsx` (new, happy-dom) — renders default/linked, hides New agent on Home, absent fields omitted
