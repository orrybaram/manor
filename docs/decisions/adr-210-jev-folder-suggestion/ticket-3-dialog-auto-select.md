---
title: New Workspace dialog auto-selects a suggested folder
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# New Workspace dialog auto-selects a suggested folder

Read section 4 of the Decision in `docs/decisions/adr-210-jev-folder-suggestion/index.md`. Load the `react` skill guidance in `.claude/skills/react/` if present and follow the codebase's React patterns.

## Behaviour

In `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`:

1. **New state.**
   - `folderTouched: boolean`. Set it to true in the folder combobox's `onChange`, and when `createFolder` picks a folder. Also set it when the project select changes: that handler calls `setFolderId(null)` today. Keep the reset, and also clear any suggestion marker; it should *not* mark the folder touched, so a new project can still get a suggestion.
   - `suggestion: { folderId: string; confidence: number } | null`.
   - `jevConnected: boolean`.
   - Reset all three in `handleOpenAutoFocus`. In the same place, kick off `window.electronAPI.typesafe.isConnected()` and set `jevConnected` from its result. Swallow errors: a browser client may not have the method, so treat that as false.
2. **Suggest.** Do this only while all of these hold:
   - `jevConnected`
   - `!folderTouched`
   - `initialFolderId == null`
   - `activeProjectId`
   - `folders.length > 0`
   - `name.trim()` is non-empty

   Debounce 400 ms on `[name, branchName, agentPrompt (only if agentOpen), activeProjectId]`, then call `window.electronAPI.typesafe.suggestFolder(activeProjectId, { name, branchName, agentPrompt })`.
   - Guard against stale replies with a request counter ref: ignore the reply if a newer request has started, or the user has since touched the folder.
   - On a non-null result, `setFolderId(result.folderId)` and `setSuggestion(result)`.
   - On `null`, leave the current pick alone. Clear the suggestion only if the current folder came from a previous suggestion; in that case revert to no folder, so a stale guess doesn't stick after the name changes meaning.
   - Do the debounce with a `useEffect` + `setTimeout` + cleanup unless the codebase has a debounce hook; grep `src/hooks` for one first.
3. **Marker.** When `suggestion && suggestion.folderId === activeFolderId && !folderTouched`, render a small muted "Suggested" label right after the folder `SearchableSelect`. Wrap it in `<Tooltip>` (`src/components/ui/Tooltip/Tooltip`) with the content `Picked by Jev · ${Math.round(confidence*100)}% confident`. Style it in `NewWorkspaceDialog.module.css` (small text, muted colour, matching the existing `.hint`). Give it `data-testid="new-workspace-folder-suggested"`.
4. **Submit** uses `activeFolderId` exactly as now. It never awaits a pending suggestion.

## Tests

- If the decision logic grows beyond a few lines, extract it as a pure helper next to the dialog and unit-test it in a `.test.ts`. Candidates:
  - `shouldSuggest(...)`
  - an `applySuggestionResult(current, result)` reducer
- Vitest only picks up `.ts` files, not `.tsx`.

Run `pnpm typecheck` and the relevant vitest files.

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`: state, debounced effect, marker
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.module.css`: marker style
- `src/components/sidebar/NewWorkspaceDialog/folder-suggestion.ts` (+ `.test.ts`): optional pure helpers
