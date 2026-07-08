---
title: Detect PR events and deliver notifications
status: done
priority: critical
assignee: opus
blocked_by: [1, 2, 3]
---

# Detect PR events and deliver notifications

Wire the poller to diff PR state, gate each event on its preference, and deliver
via toast (focused) or native notification (unfocused).

## New file: `src/utils/pr-notifications.ts`

Export a pure diff function and event type:

```ts
export type PrNotifyEventKind =
  | "comment"
  | "approved"
  | "changes-requested"
  | "checks-failed";

export interface PrNotifyEvent {
  kind: PrNotifyEventKind;
  title: string; // e.g. "PR #123 approved"
  body: string;  // PR title
}

export function diffPrEvents(
  prev: PrInfo | null | undefined,
  next: PrInfo | null | undefined,
): PrNotifyEvent[];
```

Rules (return `[]` if `prev` is null/undefined or `next` is null — no baseline
means no notification, so app boot and first-sight PRs stay silent):

- `next.commentCount > prev.commentCount` → `comment`
- `next.reviewDecision === "APPROVED"` && `prev.reviewDecision !== "APPROVED"` → `approved`
- `next.reviewDecision === "CHANGES_REQUESTED"` && `prev.reviewDecision !== "CHANGES_REQUESTED"` → `changes-requested`
- `(next.checks?.failing ?? 0) > 0` && `(prev.checks?.failing ?? 0) === 0` → `checks-failed`

Use `next.number` in titles and `next.title` in body. Import the renderer
`PrInfo` type from `src/store/project-store.ts` (type-only import).

## Wire into `src/hooks/usePrWatcher.ts`

In `fetchPrs`, for each matched workspace, capture `const prev = ws.pr` BEFORE
calling `updateWorkspacePr`, compute `diffPrEvents(prev, pr)`, then for each
event:

1. Map `kind` → preference key and skip if the pref is off. Read prefs via
   `usePreferencesStore.getState().preferences`:
   - `comment` → `notifyOnPrComment`
   - `approved` → `notifyOnPrApproved`
   - `changes-requested` → `notifyOnPrChangesRequested`
   - `checks-failed` → `notifyOnPrChecksFailed`
2. Deliver via a local helper `notifyPrEvent(event, url)`:
   - if `document.hasFocus()` →
     `useToastStore.getState().addToast({ id: \`pr-\${event.kind}-\${url}\`, message: event.title, detail: event.body, status: event.kind === "checks-failed" || event.kind === "changes-requested" ? "error" : "success", action: { label: "View PR", onClick: () => window.electronAPI.openExternal?.(url) ?? window.open(url) } })`
     (check how other toasts open external URLs / whether an `openExternal` IPC
     exists — if not, `window.open(url)` is fine in the renderer).
   - else → `window.electronAPI.notifications.show({ title: event.title, body: event.body, url })`.

Keep the diff+notify strictly before the `updateWorkspacePr` call so `prev`
reflects the last-seen state.

## Files to touch
- `src/utils/pr-notifications.ts` — new pure diff module (per above).
- `src/hooks/usePrWatcher.ts` — capture prev, diff, gate on prefs, deliver.

## Notes
- Import `useToastStore` from `src/store/toast-store.ts` and
  `usePreferencesStore` from `src/store/preferences-store.ts`.
- Toast ids are keyed by kind+url so repeat polls replace rather than stack.
- Do not notify on the very first poll where `prev` is null.
