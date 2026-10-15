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

# ADR-232: Surface silent failures, crashes and stuck states (#328)

## Context

Many failures in the renderer leave no trace the user can see:

- There is no React error boundary. One throwing pane blanks the whole window.
- Unhandled promise rejections go to the console only.
- `loadProjects` swallows a failure and sets `projects: []`. `App` then shows
  onboarding, as if this were a fresh install.
- `detachTabToNewWindow` and `movePaneToNewWindow` (`src/lib/detach.ts`) only
  `console.error` when the new window fails to open. Since ADR-179 a tab is
  never removed locally before the IPC call, so nothing vanishes any more.
  But the failure is still silent.
- `removeProject`, `renameWorkspace`, `setWorkspaceHidden` and
  `createWorkspaceFolder` are fire-and-forget at most call sites.
  `updateProject` rolls back and rethrows to more than 15 callers, and none of
  them catch. Settings snap back with no explanation. The setup wizard's
  Next and Done buttons do nothing.
- Some views stay in a loading state forever when their load fails:
  - Processes
  - Stats
  - a detached window whose layout read failed
  - the feedback modal

  The notification store replaces its list with `[]` when a fetch fails.
- A long tail of small cases has no cause shown:
  - DiffPane stage, unstage and discard
  - port forwards and kill
  - the GitHub nudge
  - workspace setup steps
  - task body fetch
  - merge eligibility
  - theme lists
  - host retry

#326 (`describeError`) and #327 (`<InlineError>`) are still open and are being
built in parallel. This ADR must not depend on their code.

## Decision

### D1. One error-reporting path with a "reported" mark

`addErrorToast` (`src/store/toast-store.ts`) records each error object it
reports in a `WeakSet`. `wasReported(err)` reads that set. #326 rewrites the
body of `addErrorToast` to use `describeError`. This ADR only adds the mark,
so the two changes merge without conflict.

### D2. Global `unhandledrejection` handler

`src/lib/unhandled-rejection.ts` exports `installUnhandledRejectionToasts()`.
`App` installs it once. It handles a rejection like this:

- Skips reasons that `wasReported` already marked. This lets a store action
  toast and rethrow without the user seeing a second toast.
- Skips `AbortError`.
- Toasts everything else as "Something went wrong", with the readable message
  as the detail.

The handler calls `preventDefault` only on reasons it handled.

### D3. Error boundaries

`src/components/ui/ErrorBoundary/ErrorBoundary.tsx` is a small class component
that takes a `fallback(error, reset)` render prop.

- **Pane boundary.** `PaneLayout` wraps every `LeafPane` in a
  `PaneErrorBoundary`. Its fallback shows "This pane crashed" and a
  "Reload pane" button. Reload resets the boundary, which remounts the pane.
  Sibling panes, the tab bar and the sidebar keep working.
- **Root boundary.** `AppRoot` wraps `<App/>`. Its fallback shows "Manor hit an
  unexpected error" with "Reload window". Detached windows use the same `App`,
  so this boundary covers them too. There is no separate `DetachedApp`.

The fallbacks use a local `FallbackScreen`: a title, a message and action
buttons. #327's `<InlineError>` can replace it once it lands.

### D4. Project load failure gets a retry screen

The project store gains `loadError: string | null`.

- A failed load sets `loadError` and keeps `initialLoadDone` false.
- A successful load clears `loadError`.

In `App`, `loadError` with no projects shows "Couldn't load your projects"
with a Retry button. It never shows onboarding.

### D5. Window moves toast on failure

The `catch` blocks in `src/lib/detach.ts` call `addErrorToast`, with the copy
"Couldn't move tab to a new window" or "Couldn't move pane to a new window".

A failed tab move needs no restore, because the tab never left. A failed pane
move leaves the pane in the tab that `extractPaneToTab` made for it. The pane
is not lost, and the toast says where it is.

A Retry that succeeds reopens the workspace the launch would have opened.

### D6. Store mutations report their own failures

These actions catch the error, call `addErrorToast` with specific copy, and
rethrow:

- `removeProject`
- `renameWorkspace`
- `setWorkspaceHidden`
- `createWorkspaceFolder`
- `updateProject` (after its rollback; the copy says the change was undone)
- `updateGroup`

Fire-and-forget callers need no change, because D2 skips errors these actions
already reported. Callers that await can still react. The setup wizard stays on
its step when a save fails.

`ConfirmDialog` accepts an `onConfirm` that returns a promise. While it is
pending the dialog disables its confirm button. Cancel stays live, so a
promise that never settles can't trap the user. It closes only when the
promise resolves. On rejection it stays open, and reports the error unless D1
already marked it.

`updateGroup` already toasted and rolled back; it now also rethrows, so a
grouped project's setup wizard stays on its step too. `groupErrorToast`
goes through `addErrorToast`, so its errors carry the D1 mark. `RemoveProjectDialog` uses this, and its callers pass the async
remove.

### D7. No stuck states

- **ProcessesView:** list failure renders an error with Retry. Kill and restart
  actions catch and toast. `cleaningUp` is reset in a `finally`.
- **Stats store:** gains `loadError` and `retry()`. `StatsView` renders an
  error with Retry instead of "Loading…".
- **Detached window:** `app-store` gains `layoutLoadError`. With no claimed
  panel, a detached window shows "Couldn't load this window" with a Close
  button in two cases:
  - the layout read failed
  - 10 s pass without the panel appearing
- **FeedbackModal:**
  - The whole submit runs in try/catch/finally. On failure the loading toast
    becomes an error toast, and `submitting` always resets.
  - A failed screenshot upload no longer files silently without screenshots.
    The upload needs gh with push rights to the repo, which most users lack,
    so the feedback is still filed. The result toast says it was sent without
    screenshots, and why.
- **Notification store:**
  - A failed `getAll` keeps the current list and sets `loadError`. The popover
    shows "Couldn't load notifications" with Retry when the list is empty.
  - `onNavigate`'s re-fetch keeps the list it had on failure.
  - `navigateToNotification` no longer blocks on a rejected `markRead`.

### D8. Low-priority sweep

- **FileList:** the stage, unstage and discard toasts carry
  `ipcErrorMessage(err)` as their detail.
- **Port forwards:** a new helper, `forwardedUrl` in
  `src/lib/port-forward-open.ts`, replaces `resolveUrlForHost`. It is used by
  `PortBadge`, the palette's port items and `useRemoteBrowserUrl`. When a remote port can't be forwarded it toasts "Couldn't
  forward port N", and does not open the box's localhost on this machine.
  `killPort` failures toast too.
- **GitHubNudge:**
  - The error phase explains itself.
  - A rejected `checkStatus` enters the error phase instead of staying in
    "installing".
  - Raw `<button>`s become `<Button>`.
- **WorkspaceSetupView:** an errored step shows its message, or
  "No reason given".
- **useStartTask:** a failed body fetch shows an info toast saying the
  workspace starts with the title only.
- **ProjectItem merge eligibility:** the reason includes the cause. Reopening
  the menu retries.
- **ThemeSection and ProjectSettingsPage:** a failed theme listing toasts.
- **HostAlert and HostStatusDetails:** a rejected `retryConnect` toasts.
- **CommandPalette Linear and GitHub entries:** no longer exist on main.
  Tasks moved to `useTasks`, which #327 owns. Not applicable.

## Consequences

- Errors become visible. The risk is noise. D1 and D2 keep it to one toast per
  failure, but third-party rejections the app used to ignore now show a
  "Something went wrong" toast. This is intended: they were bugs we could not
  see.
- `updateProject` and the other D6 actions now have a side effect: a toast.
  A caller that also shows the error inline (NewWorkspaceDialog's folder
  create) shows it twice. That is accepted until #327 reworks that dialog.
- `FallbackScreen` duplicates part of what `<InlineError>` will offer. This is
  a deliberate stopgap to avoid depending on #327.
- A failed pane move can't put the pane back into its original split. The
  pane stays in a tab of its own, and the toast says so.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
