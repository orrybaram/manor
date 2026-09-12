---
title: Review draft store, selection anchors, shared prompt helpers
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Review draft store, selection anchors, shared prompt helpers

Pure foundations — no UI. Everything later tickets import.

## 1. `src/store/review-store.ts` (new)

A zustand store in the style of `src/store/toast-store.ts` (small, no IPC).

```ts
export interface DraftComment {
  id: string;
  filePath: string;
  /** Inclusive index range into DiffFile.lines — the inline anchor. */
  startIndex: number;
  endIndex: number;
  /** Snapshot of the selected lines, taken at creation. */
  snippet: string;
  /** "L12" or "L12–L18", for the card header. */
  startLabel: string;
  body: string;
  createdAt: number;
}
```

State:

- `drafts: Record<string, DraftComment[]>` — keyed by `workspacePath`, in
  creation order.
- `addDraft(workspacePath, draft: Omit<DraftComment, "id" | "createdAt">): string`
  — generates `crypto.randomUUID()`, appends, returns the new id.
- `updateDraft(workspacePath, id, body)`.
- `removeDraft(workspacePath, id)` — and when the last draft for a workspace
  goes, delete the key entirely so `drafts[ws]` is `undefined`, not `[]`.
- `clearWorkspace(workspacePath)` — deletes the key.

Export a module-level `const NO_DRAFTS: DraftComment[] = []` and have consumers
read `drafts[ws] ?? NO_DRAFTS`, so a workspace with no review keeps a stable
array identity across renders. This mirrors `NO_STAGED_FILES` in
`DiffPane.tsx`.

## 2. `src/components/workspace-panes/DiffPane/review-anchor.ts` (new)

Lift the selection-walking logic that currently lives inline in `DiffPane.tsx`'s
`onCopy` prop (around line 605-641) into shared, tested functions.

```ts
/** The diff rows a selection covers, inside the nearest [data-diff-lines]. */
export function rowsInSelection(sel: Selection): HTMLElement[];

export interface SelectionAnchor {
  startIndex: number;
  endIndex: number;
  snippet: string;
  startLabel: string;
}

/** Resolve a selection to an anchor, or null if it covers no diff rows. */
export function selectionToAnchor(sel: Selection): SelectionAnchor | null;

/** The "12: const x = 1" text `onCopy` puts on the clipboard. */
export function selectionSnippet(sel: Selection): string | null;
```

Rules, taken from the existing handler so behaviour does not change:

- Walk up from `range.commonAncestorContainer` (use `parentElement` when it is
  not an `HTMLElement`) to the closest `[data-diff-lines]`; if that misses, look
  *down* with `querySelector("[data-diff-lines]")`.
- A row counts when `sel.containsNode(row, true)`.
- Each row's first child is the line-number cell, the second is the content
  cell. A row with no content cell is skipped. Line text is
  `` `${num}: ${content}` `` when there is a number, else just the content
  (hunk headers have an empty number cell).
- `startIndex` / `endIndex` come from the first and last covered rows'
  `data-index` attributes.
- `startLabel`: the first covered row's line number, prefixed `L`. If the first
  and last numbers differ, `L<first>–L<last>` (en dash). If neither row has a
  number, fall back to `""`.
- `selectionToAnchor` returns `null` for a collapsed selection or when no rows
  are covered.

## 3. `src/lib/agent-prompt-launch.ts` — extract `flattenPrompt`

The one-line flattening (`prompt.replace(/\s*\n\s*/g, " ").trim()`) becomes an
exported `flattenPrompt(prompt: string): string`, used by
`startAgentWithPrompt` as before. Ticket 4 reuses it. Keep the existing
doc-comment's explanation of *why* it flattens; move it onto the new function.

## 4. `src/lib/harness.ts` — `adapterForKind`

Add:

```ts
/** Renderer twin of electron/harness-interrupt.ts, keyed by AgentInfo.agentKind. */
export function adapterForKind(kind: string): HarnessAdapter;
```

`"claude"` → `claudeHarness`; `"codex"`, `"opencode"` → `codexHarness`;
anything else → `codexHarness` (Ctrl-C), matching `interruptSequenceFor`'s
`default`. Note in the doc comment that this must stay in step with
`electron/harness-interrupt.ts`, which cannot be imported here because of the
electron/src tsconfig boundary.

## 5. Tests

`src/components/workspace-panes/DiffPane/__tests__/review-anchor.test.ts` —
build a small DOM (`[data-diff-lines]` with a few `[data-index]` rows shaped
like `DiffLines` output), drive a real `Selection` over it, and assert the
anchor's indices, snippet and label for: a single line, a multi-line range, a
range that includes a hunk header, and a collapsed selection (null).

Follow whatever setup the existing store/util tests use (`vitest`, see
`vitest.config.ts` and `src/store/__tests__/`).

## Files to touch
- `src/store/review-store.ts` — new: draft comments keyed by workspace
- `src/components/workspace-panes/DiffPane/review-anchor.ts` — new: selection → anchor
- `src/components/workspace-panes/DiffPane/__tests__/review-anchor.test.ts` — new
- `src/lib/agent-prompt-launch.ts` — export `flattenPrompt`
- `src/lib/harness.ts` — add `adapterForKind`
