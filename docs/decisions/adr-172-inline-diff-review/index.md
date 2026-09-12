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

# ADR-172: Inline diff comments, batched into a review, sent to an agent

## Context

Issue #133. Reading a diff in the `DiffPane` and *acting* on what you read are
two disconnected motions today. The diff is read-only: the only ways out of it
are Copy (context menu), Open in Editor, and the sidebar's PR popover, where
`PrPopover.handleSendToAgent` already proves the shape we want — take a comment,
turn it into a prompt, hand it to an agent (`src/lib/agent-prompt-launch.ts`).
But that path only works for comments GitHub already holds. Anything *you*
notice while reading your own working diff has to be retyped into a terminal
by hand, with the file and line numbers copied across manually.

Two things are missing:

1. **A place to put a note.** GitHub's inline review is the well-understood
   model: select the lines, leave a comment, and the comment is anchored to
   that code so neither you nor the agent has to restate where it lives.
2. **Batching.** A review is rarely one remark. Sending each note to an agent
   the moment it is written would interrupt the agent once per note and lose
   the fact that the notes are one coherent pass over the diff. GitHub's
   "start a review → N pending → submit" is the right shape, and it is what the
   issue asks for: *"Add multiple comments inline to a diff, which would start a
   'review', then one button to send all of the comments to an agent."*

The delivery half already has all its pieces, just no UI:

- `useAgentStore` (`src/store/agent-store.ts`) holds every live `AgentInfo`,
  each with `workspacePath`, `paneId`, `agentKind` and `status` — enough to
  list the agents running in the workspace whose diff is on screen.
- `window.electronAPI.pty.write(paneId, data)` writes into a live pane's pty
  from the renderer (`src/lib/pane-actions.ts:69` does exactly this).
- `src/lib/harness.ts` already carries the per-harness `interruptSequence()`
  that `/sessions/send` uses main-side before injecting a prompt.
- `startAgentWithPrompt` (`src/lib/agent-prompt-launch.ts`) covers the
  no-agent-running case.

The constraint that shapes the UI is that `DiffLines` is virtualized
(`@tanstack/react-virtual`): rows are absolutely positioned with a
`translateY` and measured via `virtualizer.measureElement`. Anything rendered
inline has to live *inside* a measured row or the scroll height lies.

### Decisions taken with the user up front

- **Trigger**: select text in a diff, and a floating "Comment" chip appears
  near the selection. Not a GitHub gutter `+` — the selection plumbing
  (`DiffPane`'s `onCopy` handler, which already maps a `Selection` to the
  `[data-index]` rows it covers) is the thing we reuse, and selection works
  across hunks for free.
- **Delivery**: the user picks at submit. A split button lists the running
  agents in this workspace plus "New agent".
- **Persistence**: in-memory, keyed by workspace. Drafts survive pane/tab
  switches and the 5s diff refetch; they do not survive a restart.
- **Staleness**: not handled. Comments anchor to `filePath` + line indices. If
  the diff shifts underneath a draft, the anchor may drift. Deliberate: the
  window between writing a review and submitting it is seconds, and the
  submitted prompt carries the code snippet verbatim, so an agent can find the
  code even if the anchor has moved.

## Decision

Four pieces: a store, a selection-to-anchor utility, the inline UI inside
`DiffLines`, and a submit bar that resolves a destination.

### 1. `src/store/review-store.ts` — draft comments, keyed by workspace

A small zustand store, the same shape as the other renderer stores.

```ts
export interface DraftComment {
  id: string;              // crypto.randomUUID()
  filePath: string;
  /** Inclusive index range into DiffFile.lines. The inline anchor. */
  startIndex: number;
  endIndex: number;
  /** Snapshot taken at creation, so the prompt survives anchor drift. */
  snippet: string;         // the selected lines, "12: const x = 1" style
  startLabel: string;      // e.g. "L12" / "L12-L18", for the card header
  body: string;
  createdAt: number;
}

interface ReviewStoreState {
  /** workspacePath -> comments, in creation order. */
  drafts: Record<string, DraftComment[]>;
  addDraft(workspacePath: string, draft: Omit<DraftComment, "id" | "createdAt">): string;
  updateDraft(workspacePath: string, id: string, body: string): void;
  removeDraft(workspacePath: string, id: string): void;
  clearWorkspace(workspacePath: string): void;
}
```

`drafts` is a plain record so a workspace with no review keeps a stable empty
identity (the `NO_STAGED_FILES` trick already used in `DiffPane`).

### 2. `src/components/workspace-panes/DiffPane/review-anchor.ts` — selection → anchor

`DiffPane`'s `onCopy` handler already walks a `Selection` to the `[data-index]`
rows it covers, inside the nearest `[data-diff-lines]` container, and builds
`"<num>: <content>"` lines. That logic is lifted verbatim into two exported
functions so the copy handler and the comment chip share one implementation:

- `rowsInSelection(sel: Selection): { container: Element; rows: Element[] } | null`
- `selectionToAnchor(sel, filePath): { startIndex, endIndex, snippet, startLabel } | null`

`onCopy` is rewritten to call `selectionToAnchor` so there is exactly one
definition of "which lines does this selection cover".

`startLabel` reads the row's rendered line number, so it matches what the user
sees: `L12` for one line, `L12–L18` for a range.

### 3. Inline UI

**`SelectionCommentChip`** — rendered by `DiffPane` into a fixed-position
portal. Subscribes to `selectionchange` on the document; when the selection is
non-empty and lands inside this pane's diff rows, it positions itself at
`range.getBoundingClientRect()` (below the selection, flipped above near the
viewport bottom) and shows one `<Button variant="secondary" size="sm">` with a
`MessageSquarePlus` icon. Clicking it resolves the anchor, adds an empty draft
to the store, and puts that draft into "editing" state.

**`DiffCommentCard`** — one draft comment, rendered *inside* the virtualized
row whose index equals the draft's `endIndex`. `DiffLines` gains two props:

```ts
comments?: DraftComment[];          // drafts for this file only
editingId?: string | null;
```

and, after the line content inside the row `<div>`, renders every comment
anchored at that index. Because the row already carries `ref={measureRef}`,
`virtualizer.measureElement` picks up the taller row and the scroll height
stays honest — no change to the virtualizer's configuration. The rows the
comment spans (`startIndex..endIndex`) get a `data-commented` attribute for a
left accent bar, mirroring GitHub's "this code has a comment on it" tint.

The card itself follows Claude Desktop's composer: a rounded surface
(`--surface`, 1px `--border`, 8px radius), an auto-growing `<textarea>` with a
placeholder of "Leave a comment…", ⌘↵ / Esc handling, and a footer row with
`Cancel` and `Add comment` (`Button`, `ghost` + `primary`). Once saved it
collapses to a read view — body text plus a hover row of `Edit` / `Delete`
ghost buttons — so a finished review reads as annotated code rather than a
wall of inputs.

Anchors are resolved cheaply and defensively in `DiffPane`: drafts are grouped
by `filePath` with `useMemo`, and a draft whose file is no longer in the diff,
or whose `endIndex` is past the end of `file.lines`, simply does not render
inline. It stays in the store and is still submitted — the snippet carries it.

### 4. `ReviewBar` — the floating submit control

A pill pinned bottom-right inside the `DiffPane` container (next to, and
offset above, the existing `backToTop` button), shown only when the workspace
has at least one draft:

```
[ 💬 3 comments ]  [ Submit review ▾ ]  [ Discard ]
```

"Submit review" is a split button. The caret opens a `Popover` (Radix Popover
is already a dependency; `@radix-ui/react-dropdown-menu` is not, and adding it
for one menu is not worth it) listing:

- every agent from `useAgentStore` with `workspacePath === this workspace`,
  `status === "active"` and a non-null `paneId` — labelled with the agent's
  name (via `cleanAgentTitle`) and an `AgentDot` for its live status;
- a separator, then **New agent**.

Clicking the button body (not the caret) uses the default destination: the
first running agent if there is one, otherwise New agent — so the common case
is one click and the menu is an override.

### 5. `src/lib/review-submit.ts` — prompt + delivery

```ts
export function reviewPrompt(comments: DraftComment[]): string
export function submitReview(
  workspacePath: string,
  comments: DraftComment[],
  target: { kind: "agent"; agent: AgentInfo } | { kind: "new" },
): void
```

`reviewPrompt` builds one message in the register `reviewCommentPrompt`
already established in `PrPopover`:

```
Address these 3 review comments on the current diff:
[1] src/store/app-store.ts L120-L124 — <body>   ```<snippet>```
[2] ...
```

**The prompt is flattened to a single line** before it is written, exactly as
`startAgentWithPrompt` does and for the same reason: the text is typed into a
harness's prompt box, and a bare newline submits the turn early. A shared
`flattenPrompt` helper is extracted from `agent-prompt-launch.ts` so both
callers use one definition.

`submitReview` dispatches:

- `kind: "new"` → `startAgentWithPrompt(workspacePath, prompt)`. Unchanged
  path; this also covers "no agent is running".
- `kind: "agent"` → mirror `/sessions/send`'s ordering exactly:
  `pty.write(paneId, interruptSequenceFor(agent.agentKind))` then
  `pty.write(paneId, prompt + "\r")`, then `navigateToAgent(agent)` so the
  user lands on the pane that is about to answer. The interrupt sequence comes
  from a new `adapterForKind(agentKind): HarnessAdapter` in `src/lib/harness.ts`
  — the renderer twin of `electron/harness-interrupt.ts`, which cannot be
  imported across the tsconfig boundary.

On success the store's `clearWorkspace` empties the review and a toast
confirms ("Sent 3 comments to <agent>").

## Consequences

**Better**

- The gap between noticing something in a diff and telling an agent about it
  closes to: select, type, submit. No retyping paths or line numbers.
- Batching means one interrupt per review instead of one per remark, which
  matters because interrupting mid-turn can discard in-flight work — the
  reason `/sessions/send` returns the pre-interrupt `lastAgentStatus` at all.
- Steering an already-running agent from the UI becomes possible for the first
  time. It exists over MCP (`send_to_session`) and over HTTP
  (`POST /sessions/send`) but has had no in-app surface.
- One definition of "which diff lines does this selection cover", shared by
  copy and comment, where there was a one-off inside a JSX prop.

**Worse / riskier**

- **Anchor drift.** Indices into `DiffFile.lines` are only stable while `raw`
  is unchanged. Editing a file mid-review moves a draft's anchor, and the
  inline card will sit on the wrong line (or vanish, if the index no longer
  exists). Accepted per the decision above; the snippet in the prompt is the
  mitigation.
- **Flattening loses formatting.** A three-comment review arrives as one long
  line in the agent's prompt box. It reads fine to the model and matches every
  existing prompt-injection path in the app, but it is not pretty, and a
  snippet containing a newline collapses to a space. If this proves annoying,
  the follow-up is bracketed paste (`\x1b[200~…\x1b[201~`) gated on the
  session's already-tracked `modes.bracketedPaste`.
- **Row measurement cost.** Rendering a comment card inside a virtualized row
  makes that row's height dynamic and large. The virtualizer handles it, but a
  review with many comments in one file means many re-measures on scroll.
  Bounded in practice by how many comments a person writes.
- **Interrupt is destructive-ish.** Sending into a busy agent ends its current
  turn. The menu shows live status via `AgentDot` so the user can see they are
  about to interrupt work, but there is no confirmation step.
- **Drafts are lost on restart.** Deliberate, and cheap to revisit — the store
  is the only thing that would change.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
