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

# ADR-147: PR Update Notifications

## Context

The app already polls GitHub for the PR attached to each non-main workspace
(`src/hooks/usePrWatcher.ts`, every 15s + on focus/fingerprint change) and
stores the result on `WorkspaceInfo.pr` in the project store. Today that data is
only rendered passively in the PR popover — nothing tells the user when a
reviewer acts on their PR.

Users want to be notified when their open PRs change:

- **New comments** (a reviewer leaves feedback)
- **Review approved** (`reviewDecision` → `APPROVED`)
- **Changes requested** (`reviewDecision` → `CHANGES_REQUESTED`)
- **CI checks failed** (`statusCheckRollup` gains a failure)

…and to turn each of these on/off.

Everything needed already exists:

- `getPrForBranchInner` (`electron/github.ts`) fetches `reviewDecision` and
  `statusCheckRollup`, and `getUnresolvedThreadCount` runs a `gh api graphql`
  query for review threads. The only missing datum is a **comment count** to
  diff for "new comments".
- Native notifications exist via `maybeSendNotification` (`electron/notifications.ts`),
  but are only triggered from agent status changes in the main process. There is
  no IPC to fire a native notification on demand from the renderer.
- In-app toasts exist via `useToastStore` (`src/store/toast-store.ts`).
- Boolean preferences have a complete end-to-end pattern
  (`electron/preferences.ts` ↔ `src/store/preferences-store.ts` ↔
  `NotificationsPage.tsx`), gated in the notification path via
  `preferencesManager.get(...)`.

## Decision

**Detect events in the renderer poller, deliver via toast-when-focused /
native-when-unfocused, gate each event type behind a preference.**

### 1. Extend PR data with a comment count

Add `commentCount?: number` to `PrInfo` (`electron/github.ts`). Fold it into the
existing GraphQL query in `getUnresolvedThreadCount` (rename intent to
"fetch PR conversation state"): request `comments { totalCount }` and
`reviews { totalCount }` on the `pullRequest` alongside `reviewThreads`, and sum
issue-comments + reviews into `commentCount`. This keeps the network cost at one
extra field on an already-running query. Thread the field through
`usePrWatcher.ts` → `updateWorkspacePr` → project-store `PrInfo`.

Tradeoff: `commentCount` counts *any* new comment/review, not strictly a comment
addressed to the user. This is the pragmatic proxy and matches how
`unresolvedThreads` already works. Precise per-comment attribution (IDs +
timestamps) is deliberately out of scope.

### 2. Four new boolean preferences

Add to `AppPreferences` (both `electron/preferences.ts` and `src/electron.d.ts`),
`DEFAULTS`, and the renderer default mirror in `src/store/preferences-store.ts`:

- `notifyOnPrComment` (default `true`)
- `notifyOnPrApproved` (default `true`)
- `notifyOnPrChangesRequested` (default `true`)
- `notifyOnPrChecksFailed` (default `true`)

The generic `preferences:set` / `preferences:getAll` IPC needs no changes.

### 3. Native-notification IPC for the renderer

Add a `notifications:show` handler (main) that takes `{ title, body, url }`,
shows a silent native `Notification` **only when the window is not focused**
(mirroring `maybeSendNotification`), plays the configured `notificationSound`,
and on click calls `shell.openExternal(url)` + focuses the window. Expose it via
`electron/preload.ts` (`notifications.show`) and type it in `src/electron.d.ts`.

### 4. Event detection + delivery in the poller

In `fetchPrs` (`usePrWatcher.ts`), for each workspace compare the **previous**
`ws.pr` (already held in the store snapshot) against the freshly fetched `pr`
*before* calling `updateWorkspacePr`. Extract this into
`src/utils/pr-notifications.ts` (`diffPrEvents(prev, next)` →
`PrNotifyEvent[]`) so it is unit-testable and keeps the hook lean.

Rules (only fire when `prev` is non-null — no baseline means no notification, so
app boot and first-sight PRs stay silent):

- `next.commentCount > prev.commentCount` → **comment**
- `next.reviewDecision === "APPROVED"` && `prev.reviewDecision !== "APPROVED"` → **approved**
- `next.reviewDecision === "CHANGES_REQUESTED"` && `prev.reviewDecision !== "CHANGES_REQUESTED"` → **changes-requested**
- `(next.checks?.failing ?? 0) > 0` && `(prev.checks?.failing ?? 0) === 0` → **checks-failed**

For each event, gate on the matching preference
(`usePreferencesStore.getState().preferences`). If passing, dispatch through a
single helper `notifyPrEvent(title, body, url)`:

- `document.hasFocus()` → `useToastStore.getState().addToast(...)` with a
  "View PR" action opening the URL.
- otherwise → `window.electronAPI.notifications.show({ title, body, url })`.

### 5. Settings UI

Add a "Pull requests" section to `NotificationsPage.tsx` with four `<Switch>`
rows bound to the new prefs, following the existing `notifRow` markup.

## Consequences

**Better:** Users get actionable, native + in-app alerts for PR activity, each
independently toggleable, with zero new polling infrastructure (reuses the 15s
watcher). Diff logic is isolated and unit-testable.

**Harder / risks:**

- The renderer poller is now the notification source of truth. If the app is
  fully closed (not just backgrounded) no notifications fire — acceptable; the
  existing agent notifications share this constraint.
- `commentCount` is a coarse proxy; edits/deletes could theoretically move the
  count non-monotonically, but we only notify on a strict increase, so the
  worst case is a *missed* (never a spurious) notification.
- One extra `gh api graphql` field per poll — negligible.
- `notifications:show` is a new renderer→main capability; it is
  content-restricted to title/body/url and only opens external URLs.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
