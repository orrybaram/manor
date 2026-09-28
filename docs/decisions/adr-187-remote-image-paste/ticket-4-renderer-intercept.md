---
title: Intercept image paste on remote terminal panes
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# Intercept image paste on remote terminal panes

See ADR-187 §4. Read `.claude/rules/ui-components.md` and the `react` skill conventions before editing.

1. Create `src/lib/remote-image-paste.ts`:
   - `isRemotePane(paneId)`: true when `useRemotePaneStore.getState()` has a non-local host for the pane. Read `src/store/remote-pane-store.ts` to find the right selector, and treat `LOCAL_HOST_ID` / missing as local.
   - `async pasteClipboardImage(term: Terminal, paneId: string, fallback: () => void): Promise<void>` calls `window.electronAPI.terminal.pasteClipboardImage(paneId)`. On `uploaded`, `term.paste(result.path + " ")`. On `local`/`none`, `fallback()`. On `error`, `useToastStore.getState().addToast(...)` with an error toast; match the existing addToast call shape in `src/lib/menu-handlers.ts`.
2. **Ctrl+V** in `src/hooks/useTerminalHotkeys.ts`: `attachHandler` needs the paneId. Add a parameter, update the call site in `useTerminalLifecycle.ts`, and add the `term` it already has. Before the "no modifier" early return, handle `e.key.toLowerCase() === "v" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && isRemotePane(paneId)`: on keydown call `void pasteClipboardImage(term, paneId, () => ptyWrite("\x16"))`, and return false for every event type.
3. **DOM paste event** in `useTerminalLifecycle.ts`: after `t.open(container)`, add a capture-phase `paste` listener on `container`. If `isRemotePane(paneId)` and `e.clipboardData` has an item with `type.startsWith("image/")` and `getData("text/plain")` is empty, call `e.preventDefault()` and `e.stopPropagation()`, then `void pasteClipboardImage(t, paneId, () => {})`. Remove the listener in the effect cleanup.
4. **Context menu Paste** in `src/components/workspace-panes/TerminalPane/TerminalPane.tsx` (~line 132): when the pane is remote, call `pasteClipboardImage` with the existing readText-and-paste code as the fallback. Local panes keep the current code path.

Add unit tests for `remote-image-paste.ts` that mock `window.electronAPI` and the stores to cover each result kind.

## Files to touch
- `src/lib/remote-image-paste.ts` (new) + test
- `src/hooks/useTerminalHotkeys.ts`
- `src/hooks/useTerminalLifecycle.ts`
- `src/components/workspace-panes/TerminalPane/TerminalPane.tsx`
