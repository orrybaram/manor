---
title: Seam — TaskRef, normalized TaskDetail and task actions
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Seam — TaskRef, normalized TaskDetail and task actions

ADR-207 §1. No UI changes in this ticket.

## Types (`src/lib/tasks.ts`)

- `TaskRef = { provider: TaskProvider; project: ProjectInfo; id: string; displayId: string; title: string; url: string }`.
  GitHub `id` uses the existing link convention `"gh-<number>"`; Linear `id` is the issue id.
- `TaskDetail = { body: string | null; status: { label: string; tone: TaskStatusTone }; assignees: string[]; labels: TaskLabel[]; priority?: { value: number; label: string }; milestone?: string; images: string[] }`.
  Images: move `extractImages` out of `src/components/command-palette/utils.ts` into `src/lib/` (keep the old export working until ticket 5 deletes it, or re-export).

## Tracker interface (`src/lib/trackers/types.ts`)

- `refOf(row: TaskRow): TaskRef`
- `refFromLink(link: LinkedIssue, project: ProjectInfo): TaskRef`
- `detailQuery(ref: TaskRef): TrackerQuery<TaskDetail>` — replaces the body-only `detailQuery(row)`. New query key `["task-detail", provider, …identity]` (Linear: id; GitHub: hostId, path, number, url). Must NOT reuse `linear-issue-detail` / `github-issue-detail` — those are cached with a different shape by the palette detail views today (collision bug).
- Optional:
  - `startHere?(ref, detail: TaskDetail | null, opts: { onNewAgentWithPrompt: (prompt: string) => void; projectId: string; workspacePath: string }): void` — port from `IssueDetailView.handleNewAgent` (Linear: `linear.startIssue`) and `GitHubIssueDetailView` (GitHub: `assignIssueBestEffort`), then `useProjectStore.getState().linkIssueToWorkspace(...)`. Prompt = `title\n\nbody`.
  - `unlink?(ref, projectId, workspacePath): Promise<void>` — `linear.unlinkIssueFromWorkspace(projectId, workspacePath, ref.id)` then `loadProjects()`.
  - `close?(ref): Promise<void>` — `linear.closeIssue(id)` / `github.closeIssue(repo, number)`.
  Implement on both adapters. Throw on failure; callers toast.

## Callers

- `src/components/tasks/useStartTask.ts`: `fetchQuery({...tracker.detailQuery(tracker.refOf(row)), retry: false})` then pass `detail?.body ?? null` to `startWork`.
- Fix the stale "Same key as the palette's detail view" comments.

## Tests

Extend `src/lib/trackers/linear.test.ts` and `github.test.ts`: `refOf`, `refFromLink` (gh-N parse), `detailQuery` normalization (status tone, labels, priority, milestone, images, null body).

## Files to touch
- `src/lib/tasks.ts` — `TaskRef`, `TaskDetail`
- `src/lib/trackers/types.ts` — interface changes
- `src/lib/trackers/linear.ts`, `src/lib/trackers/github.ts` — implementations
- `src/lib/trackers/memory.ts` — keep the in-memory tracker compiling
- `src/lib/trackers/linear.test.ts`, `src/lib/trackers/github.test.ts`
- `src/components/tasks/useStartTask.ts`
- `src/lib/task-images.ts` (new) — `extractImages`
