---
title: Toast wiring hook (useUpdaterToasts)
status: done
priority: high
assignee: sonnet
blocked_by: [4]
---

# Toast wiring hook

Translate updater store transitions into toasts per the Q5 / Q8 / Q13 rules. Auto-checks stay silent except for download-complete; manual checks emit the full trio.

## Behavior

Create `src/hooks/useUpdaterToasts.ts`. Mount it once in `src/App.tsx` at the top level (next to other global hooks).

The hook subscribes to `useUpdaterStore` and reacts to state transitions:

| Transition | Toast id | Behavior |
|---|---|---|
| `pending` becomes non-null | `updater-pending` | Sticky (`persistent: true`), status `success`, message "Manor {version} ready to install", `action: { label: "Restart now", onClick: quitAndInstall }`, `secondaryAction: { label: "Later", onClick: () => removeToast("updater-pending") }`. |
| `checking === true` AND `lastTriggerWasManual === true` | `updater-checking` | `status: "loading"`, message "Checking for updates…". |
| `checking` flips to false AND was manual AND `pending` still null AND no error | `updater-checking` (replaced) | `status: "success"`, message "You're on the latest version". Default auto-dismiss. |
| `error` becomes non-null AND was manual | `updater-checking` (replaced) or new id `updater-error` | `status: "error"`, message "Couldn't check for updates", `detail: error`. |
| Auto-check transitions (manual === false) | — | No toasts emitted, except `pending` which always emits regardless. |

Use `useToastStore.getState().addToast(...)` (not the hook form) inside `useEffect` to avoid re-render loops. The store's deduplication-by-id behavior already handles the "replace" case — just call `addToast` with the same id and updated content.

For the "checking flipped to false" success case, you'll need to track previous state with a ref (`useRef<{checking: boolean, pending: any, error: string | null}>(...)`) since zustand's subscribe doesn't give you prev/next directly inside a `useEffect` cleanly.

## Files to touch
- New: `src/hooks/useUpdaterToasts.ts`
- `src/App.tsx` — mount the hook

## Acceptance
- Manual check from AboutModal in a packaged build shows "Checking…" → "You're on the latest version" (or pending toast if found).
- Auto-check on launch produces no checking/up-to-date toasts; only the sticky pending toast if an update is downloaded.
- "Later" on the pending toast dismisses it; refreshing the app re-shows it (next launch's `update-downloaded` re-fires).
- `pnpm lint` and typecheck pass.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-141): Toast wiring hook (useUpdaterToasts)"

Replace NNN with the ADR number and use the exact ticket title as the commit message body.
Do not push.
