---
title: Adopt emoji autocomplete in sidebar name inputs
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Adopt emoji autocomplete in sidebar name inputs

Wire `ui/EmojiAutocomplete` (ticket 2) into every field that holds a
folder, workspace, agent or project name. Do not change commit, cancel or
validation behaviour.

- `src/components/sidebar/NewFolderDialog.tsx`: `Input` → `EmojiInput`.
- `src/components/sidebar/ConvertToWorkspaceDialog.tsx`: `Input` →
  `EmojiInput`.
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`: both
  "Name" `Input`s (`data-testid="new-workspace-name-input"`) → `EmojiInput`.
  Leave the ghost monospace branch-name `Input` alone.
- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx`: only
  the "Project Name" `Input` (~line 330) → `EmojiInput`.
- `src/components/sidebar/FolderItem.tsx`: the raw rename `<input
  ref={editRef}>`. Call `useEmojiAutocomplete(editRef, { enabled: editing })`,
  spread `fieldProps` (compose with the existing `onBlur={commitRename}`), and
  call `handleKeyDown(e)` at the top of `onKeyDown`. If it returns true,
  return early; it has already stopped propagation. Render `suggestions` next
  to the input.
- `src/components/sidebar/ProjectItem.tsx`: the workspace rename input is
  rendered in the row component (~line 139) but its handlers come from props
  (~line 465). Call the hook in the row component that owns `editRef`, and
  run `handleKeyDown` before calling `onEditKeyDown`. Compose `fieldProps`
  `onBlur` with `onEditBlur`. Render `suggestions`.
- `src/components/sidebar/AgentsList.tsx` and
  `src/components/sidebar/AgentsView/AgentsView.tsx`: pass `{ emoji: true }`
  to `useInlineRename` and render `{rename.suggestions}` next to the input.

Check that an option clicked in the inline renames does not trigger the blur
commit, and that Escape with the list open does not cancel the rename.

## Files to touch
- `src/components/sidebar/NewFolderDialog.tsx`
- `src/components/sidebar/ConvertToWorkspaceDialog.tsx`
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx`
- `src/components/sidebar/FolderItem.tsx`
- `src/components/sidebar/ProjectItem.tsx`
- `src/components/sidebar/AgentsList.tsx`
- `src/components/sidebar/AgentsView/AgentsView.tsx`
