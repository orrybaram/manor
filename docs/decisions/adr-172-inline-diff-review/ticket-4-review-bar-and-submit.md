---
title: Review bar, destination picker, and submit-to-agent
status: done
priority: critical
assignee: opus
blocked_by: [1, 2, 3]
---

# Review bar, destination picker, and submit-to-agent

The closing half: batch the drafts into one prompt and choose who gets it.

## 1. `src/lib/review-submit.ts` (new)

```ts
export type ReviewTarget =
  | { kind: "agent"; agent: AgentInfo }
  | { kind: "new" };

export function reviewPrompt(comments: DraftComment[]): string;
export function submitReview(
  workspacePath: string,
  comments: DraftComment[],
  target: ReviewTarget,
): void;
```

**`reviewPrompt`** — same register as `reviewCommentPrompt` in
`src/components/sidebar/PrPopover.tsx` (read it first). Shape:

```
Address these 3 review comments on the current diff:
[1] src/store/app-store.ts L120–L124 — <body>
    Code: <snippet>
[2] …
```

Singular wording for one comment ("Address this review comment on the current
diff:"). Build it multi-line for readability, then hand it to
`flattenPrompt` (ticket 1) at the call site in `submitReview` — the flattening
happens once, in one place, so `reviewPrompt` stays testable as readable text.

**`submitReview`** dispatches on target:

- `kind: "new"` → `startAgentWithPrompt(workspacePath, prompt)` and return.
- `kind: "agent"`:
  1. `const paneId = agent.paneId` — bail (and toast an error) if null.
  2. `window.electronAPI.pty.write(paneId, adapterForKind(agent.agentKind).interruptSequence())`
  3. `window.electronAPI.pty.write(paneId, flattenPrompt(prompt) + "\r")`
  4. `navigateToAgent(agent)` so the user lands on the pane that will answer.

  The interrupt-then-prompt ordering is load-bearing and must not gain an
  artificial delay between the two writes — mirror the comment on
  `POST /sessions/send` in `electron/routes/agents.ts` and say so here too.

On success, `useToastStore.getState().addToast(...)` with
`"Sent 3 comments to <agent name>"` / `"Sent 3 comments to a new agent"`,
`status: "success"`, `duration: 3000`.

Clearing the drafts is the **caller's** job (ticket's ReviewBar), not
`submitReview`'s — keeps this module free of store writes other than the toast.

## 2. `ReviewBar` (new component dir)

`src/components/workspace-panes/DiffPane/ReviewBar/ReviewBar.tsx` + `.module.css`.

```ts
type ReviewBarProps = { workspacePath: string };
```

Renders nothing when the workspace has no drafts. Otherwise a pill pinned
bottom-right *inside* the `DiffPane` container, sitting above the existing
`.backToTop` button (bump `backToTop`'s `bottom` while the bar is shown, or
give the bar a higher `bottom` — either way they must not overlap; check
`DiffPane.module.css`).

Layout:

```
[ 💬 3 comments ]   [ Submit review │ ▾ ]   [ Discard ]
```

- Count: `MessageSquare` icon + `"{n} comment{s}"`, `--text-dim`, 11px.
- **Split button**: two adjacent `Button`s sharing a rounded outline — body
  `variant="primary"` reading "Submit review", caret `variant="primary"` with a
  `ChevronUp` icon (size 12), joined by flattening the inner border radii in
  CSS. The caret is a Radix `Popover.Trigger`
  (`@radix-ui/react-popover` is already a dependency —
  **do not add `@radix-ui/react-dropdown-menu`**).
- `Discard`: `variant="ghost"`, clears the workspace's drafts. Ask for
  confirmation inline (the button becomes "Discard 3 comments?" / "Yes" on
  first click) rather than opening a dialog.

**Destinations**, computed with `useAgentStore`:

```ts
const agents = useAgentStore((s) =>
  s.agents.filter(
    (a) => a.workspacePath === workspacePath && a.status === "active" && a.paneId,
  ),
);
```

Sort most-recently-updated first (`updatedAt` desc). The popover lists each as
a row: an `AgentDot` (`src/components/ui/AgentDot/`) for live status, the name
via `cleanAgentTitle` (`src/utils/agent-title.ts`) falling back to the agent
kind, and a dim "will interrupt current turn" hint when
`lastAgentStatus` is not idle (`adapterForKind(a.agentKind).isIdle(a.lastAgentStatus)`
is false). Then a separator and a **New agent** row with a `Plus` icon.

The button body uses the default destination — `agents[0]` if any, else
`{ kind: "new" }` — so the common case is one click. The popover is the
override. Label the body button with the default's name when there is a running
agent (e.g. "Submit to claude") and plain "Submit review" otherwise, so the one
click is never a surprise.

On submit: call `submitReview(...)`, then
`useReviewStore.getState().clearWorkspace(workspacePath)`.

## 3. Mount it

In `DiffPane.tsx`, render `{workspacePath && <ReviewBar workspacePath={workspacePath} />}`
alongside the existing `CommitModal` — in **all three** return paths (loading,
error, and the main one), since a draft review must not disappear because the
diff momentarily failed to load or went empty.

## 4. Tests

`src/lib/__tests__/review-submit.test.ts`:

- `reviewPrompt` for one comment vs. three — asserts numbering, the file and
  label prefix, and that bodies/snippets survive.
- `submitReview` with `kind: "agent"` — stub `window.electronAPI.pty.write`,
  assert exactly two writes, in order, the first being `"\x1b"` for an agent of
  kind `claude` and `"\x03"` for `codex`, the second ending in `"\r"` and
  containing no `"\n"`.
- `submitReview` with `kind: "new"` — assert `startAgentWithPrompt` is called
  and no pty write happens.

Follow the mocking style already used in `src/store/__tests__/`.

## Files to touch
- `src/lib/review-submit.ts` — new: prompt building + delivery
- `src/lib/__tests__/review-submit.test.ts` — new
- `src/components/workspace-panes/DiffPane/ReviewBar/ReviewBar.tsx` — new
- `src/components/workspace-panes/DiffPane/ReviewBar/ReviewBar.module.css` — new
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — mount `ReviewBar` in all three return paths
- `src/components/workspace-panes/DiffPane/DiffPane.module.css` — keep `.backToTop` clear of the bar
