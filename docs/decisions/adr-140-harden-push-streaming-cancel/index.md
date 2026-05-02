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

# ADR-140: Harden Git Push with Streaming, Cancellation, and Categorized Errors

## Context

ADR-121 added a Push button in the DiffPane that calls `git push` via a buffered `execFile` with a 60s timeout. In practice this fails silently in several ways:

- **No live output.** `execFile` buffers stdout/stderr until the process exits. While push is running (which can take seconds to minutes for large repos or slow networks), the user sees only a frozen spinner.
- **Silent timeouts.** When the 60s timeout fires, the SIGTERM produces an empty `stderr`, so the error message degrades to a generic `"Push failed"` with no context.
- **Hung credential prompts.** Without a TTY, git's askpass may invoke a GUI prompt or block on `/dev/tty`. Stale credentials or a misconfigured helper can cause an indefinite hang that looks identical to a successful in-progress push.
- **No cancellation.** The user has no way to abort a stuck push short of force-quitting the app.
- **Generic errors.** Common, fixable failures (no upstream branch, non-fast-forward) are surfaced as raw stderr instead of actionable UI.

The user's report: *"git push can fail with no error. It tries pushing up but nothing happens after a few seconds. No errors or anything. Push needs to be refined in general."*

## Decision

Replace the buffered `push()` with a streaming, cancellable `pushStream()` that surfaces live progress via toast, fails fast on missing credentials, and offers targeted recovery actions for the two most common errors.

### Backend

- Add `pushStream(cwd, opts, callbacks): { cancel: () => void }` to `GitBackend` (`electron/backend/types.ts`).
- Implement in `LocalGitBackend` (`electron/backend/local-git.ts`) using `child_process.spawn`:
  - Args: `["push", remote ?? "origin", branch]` plus an optional `--set-upstream` flag for the no-upstream auto-retry.
  - Env: `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=/bin/true` to fail fast on missing credentials instead of hanging on a TTY/GUI prompt.
  - Line-buffer `stderr` (split on `\n`) and invoke `callbacks.onLine(line)` per line.
  - On `close`, drain remaining stderr buffer, then call `callbacks.onDone({ exitCode, stderr })`.
  - `cancel()` returns a closer that sends `SIGTERM` to the child.
- Delete the existing `push()` method.
- Add a pure `categorizePushError(stderr): { kind, message, action? }` (new module: `electron/backend/push-error.ts`). Recognized kinds: `no-upstream`, `non-fast-forward`, `auth`, `network`, `permission`, `hook-rejected`, `unknown`. Most kinds use `kind` + a friendlier `message`; only `no-upstream` and `non-fast-forward` carry an `action` hint that the renderer turns into a button.

### IPC

Three channels in `electron/ipc/branches-diffs.ts` (or a new `electron/ipc/git-push.ts`):

- `git:push:start` — `ipcMain.handle`. Args: `{ wsPath, setUpstream?: boolean }`. Spawns the child, registers it in a per-renderer `Map<pushId, ChildProcess>`, returns `{ pushId, startedAt }`. `pushId` is the workspace path (already unique per active push).
- `git:push:progress` — `webContents.send` event. Payload: `{ pushId, type: "line" | "done" | "error", line?, exitCode?, stderr?, errorKind?, errorMessage?, errorAction? }`.
- `git:push:cancel` — `ipcMain.handle`. Args: `{ pushId }`. Sends `SIGTERM` to the tracked child, lets `done` event fire normally with non-zero exit.

Active children are tracked in a module-level Map and killed on `before-quit` (registered alongside existing app-lifecycle hooks).

### Preload

Replace `electronAPI.git.push` with:

```ts
electronAPI.git.push.start(args): Promise<{ pushId, startedAt }>
electronAPI.git.push.cancel(pushId): Promise<void>
electronAPI.git.push.onProgress(handler): () => void  // returns unsubscribe
```

### UI — Toast

Push is surfaced through the existing `useToastStore` (toast id = `push-${workspacePath}`, deduped by store).

- **Loading**: spinner + `"Pushing… {elapsed}s"` (renderer ticks elapsed locally from `startedAt`). `detail` shows the most recent stderr line. `persistent: true`. Cancel action button.
- **Success**: check + `"Pushed to {remote}/{branch}"`. Auto-dismiss 3s.
- **Cancelled**: x + `"Push cancelled"`. Auto-dismiss 3s.
- **Error**: x + categorized message. `detail` = full stderr, **auto-expanded**, max-height 300px with internal scroll. Persistent.
  - `no-upstream`: action button "Push with --set-upstream" → re-invokes start with `setUpstream: true`.
  - `non-fast-forward`: action button "Pull & retry" → invokes existing pull (if available) then retries push, otherwise links to terminal.
  - All others: stderr only.

`ToastItem` (`src/components/ui/Toast/ToastItem.tsx`) gains an `expanded` local state. Long `detail` is collapsed (1 line, truncated) by default; clicking the body toggles. Errors auto-expand on mount.

### UI — DiffPane

`src/components/workspace-panes/DiffPane/DiffPane.tsx`:

- Replace `handlePush` to call `electronAPI.git.push.start`, then drive toast updates from the global `onProgress` subscription.
- Delete the inline `pushError` state and its rendering — toast is the single source of truth.
- Keep the Push button disabled while a push for this workspace is in flight (track via toast presence or a small Zustand slice).

### Tests

- **Unit**: `categorizePushError` covers all kinds with representative stderr fixtures.
- **Unit**: `pushStream` with mocked `spawn` — verify args, env (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/true`), line buffering, drain-before-done ordering, cancel kills child.
- **Integration** (`local-git.test.ts` style, real git against a bare repo): happy push, no-upstream first push, auth-fail (push to nonexistent remote URL).

## Consequences

**Better**
- User sees live progress; "frozen spinner" disappears.
- Fail-fast on missing credentials — no more silent hangs.
- Cancellable from the toast.
- No-upstream auto-retry handles the most common first-push case in one click.
- Non-fast-forward gets a real recovery path instead of raw stderr.
- Errors are never silent — toast always surfaces stderr, even on SIGTERM.

**Risk**
- `GIT_ASKPASS=/bin/true` removes the ability to use any in-app credential prompt. Anyone relying on a GUI askpass dialog (rare on macOS where Keychain handles it) will see "Authentication failed" and need to fix credentials in their shell. Acceptable: matches what `git push` does in their terminal.
- Toast becomes the only error surface; if toast system breaks, push errors disappear. Mitigated by toast already being a hardened, widely-used component.
- Per-renderer child Map is process-local; if the renderer crashes mid-push, the `before-quit` cleanup still kills the child on app exit. No orphans.

**Out of scope**
- In-app credential UI (custom `GIT_ASKPASS` script + modal). Tracked separately if needed.
- Push to non-`origin` remotes via UI (still defaults to origin; CLI for now).
- Rebase-on-pull strategy choice for the non-fast-forward action (uses repo's configured default).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
