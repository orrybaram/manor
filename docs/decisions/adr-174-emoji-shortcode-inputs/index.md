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

# ADR-174: `:shortcode` emoji autocomplete for user-authored text inputs

## Context

Issue #207 (user feedback) asks for Slack/GitHub-style `:shortcode` emoji
completion in text fields where users write their own words: folder names,
workspace names, "any input or textarea where it might make sense", built as
a reusable component.

Right now the only way to get an emoji into a name is the macOS character
viewer (Ctrl+Cmd+Space). It works, but nobody finds it, and it steals focus
from inline rename inputs, which commit on blur.

The text fields in the app take three shapes:

| Shape | Where |
|---|---|
| `ui/Input` / `ui/Textarea` | New folder, new workspace, convert-to-workspace, project setup name, commit modal, feedback modal |
| Raw `<input>` with sidebar classes, hand-rolled Enter/Escape/blur commit | `FolderItem` folder rename, `ProjectItem` workspace rename |
| Raw `<input>` via `useInlineRename` (`src/hooks/useInlineRename.ts`) | `AgentsList`, `AgentsView` agent rename |
| Raw `<textarea>` with its own key handling | `DiffCommentCard` review comment |

The inline rename inputs are the hard case. Enter commits, Escape cancels,
blur commits, and every key is `stopPropagation`'d so the sidebar row does not
react to it. Any suggestion UI has to take over Enter, Escape and the arrow
keys while it is open, and clicking a suggestion must not blur the input.

Most text fields should **not** get emoji: search boxes, URL bars, find
bars, paths, shell scripts, keybindings, API keys, branch names, and
anything `monospace`.

There is no emoji data in the dependency tree. The repo already uses
`@radix-ui/react-popover` (see `SearchableSelect`) for floating listboxes.

One side effect: `sanitizeBranchName` (`src/utils/branch-name.ts`, mirrored
in `electron/branch-name.ts`) only strips git-forbidden ASCII. The new
workspace dialog builds the branch name from the workspace name, so once
names can easily hold emoji, the branch would be `🚀-launch`.

## Decision

### Data: `emojibase-data`, lazy-loaded

Add `emojibase-data` as a dependency and import only
`emojibase-data/en/compact.json` (emoji, label, tags, order) and
`emojibase-data/en/shortcodes/github.json` (GitHub/Slack-familiar
shortcodes). Both load through a memoized dynamic `import()` the first time a
trigger is detected, so Vite splits them into their own chunk and startup
bundle size does not change. Only default skin tones; no skin-tone picker.

### Pure logic: `src/utils/emoji-shortcode.ts`

Framework-free, unit-tested with vitest (the repo has no DOM component
tests, so the logic that can break lives here):

- `findShortcodeQuery(value, caret)` → `{ start, end, query } | null`. Matches
  a `:` at the start of the string or after whitespace, followed by 2+ chars
  from `[a-z0-9_+-]`, ending at the caret. So `10:30`, `http://` and `:)` never
  trigger.
- `loadEmojiIndex()` → memoized `Promise<EmojiEntry[]>` (`{ emoji, shortcodes,
  label, tags }`), built from the two JSON files.
- `searchEmoji(index, query, limit = 8)`: ranks an exact shortcode match first,
  then shortcode prefix, then shortcode/label/tag substring. Ties keep
  emojibase order.
- `completeClosedShortcode(value, caret, index)`: when the user types the
  closing `:` of an exact shortcode (`:tada:`), returns the replaced value and
  new caret. This is typing-through completion, as in Slack.
- `replaceRange(value, start, end, text)` → `{ value, caret }`.

### Behaviour: `useEmojiAutocomplete` in `src/components/ui/EmojiAutocomplete/`

```ts
function useEmojiAutocomplete<T extends HTMLInputElement | HTMLTextAreaElement>(
  inputRef: React.RefObject<T | null>,
  options?: { enabled?: boolean },
): {
  /** Call first in the field's onKeyDown. Returns true if it consumed the key. */
  handleKeyDown: (e: React.KeyboardEvent<T>) => boolean;
  /** Spread onto the field (onInput/onSelect/onBlur + aria-*). */
  fieldProps: { … };
  /** Render next to the field. Portalled listbox, or null. */
  suggestions: React.ReactNode;
};
```

- **Insertion goes through the native value setter plus a bubbling `input`
  event**, the same trick React Testing Library uses. React's `onChange`
  fires with the new value, so controlled callers (`setName(e.target.value)`)
  and callers that commit on blur need no changes. The caret is then placed
  after the inserted emoji.
- While the list is open, `handleKeyDown` consumes ArrowUp/ArrowDown (move),
  Enter/Tab (insert) and Escape (close the list only). It calls
  `preventDefault` + `stopPropagation`, so the rename's Enter does not commit
  and its Escape does not cancel. When the list is closed it consumes nothing.
  Keys pressed during IME composition (`e.nativeEvent.isComposing`) are
  ignored.
- The list is a Radix `Popover` anchored with `Popover.Anchor virtualRef` to
  the field, portalled so sidebar `overflow` cannot clip it, with
  `onOpenAutoFocus`/`onCloseAutoFocus` prevented so focus never leaves the
  field. Options use `onMouseDown` + `preventDefault`, like `SearchableSelect`,
  so clicking one never blurs the field and never fires a rename commit.
- ARIA: `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`,
  `aria-controls` and `aria-activedescendant` on the field, `role="listbox"`
  on the list, ids from `useId`.
- Each row shows the emoji and `:shortcode:`. Styling reuses the
  `SearchableSelect` option tokens.

### Components: `EmojiInput`, `EmojiTextarea`

Drop-in replacements for `ui/Input` and `ui/Textarea` with the same props. They
forward the ref (merged with the hook's internal ref), run `handleKeyDown`
before the caller's `onKeyDown`, and render `suggestions`. Fields that already
use `Input`/`Textarea` switch by changing the import.

Raw inputs with their own classes (`FolderItem`, `ProjectItem`,
`DiffCommentCard`) call the hook directly. `useInlineRename` gains an
`emoji` option that wires the hook into `inputProps` and returns
`suggestions`, so its callers only render `{rename.suggestions}`.

### Adopted in

- Sidebar names: `FolderItem` rename, `NewFolderDialog`, `ProjectItem`
  workspace rename, `NewWorkspaceDialog` name (both modes, not the branch
  field), `ConvertToWorkspaceDialog`, `AgentsList` + `AgentsView` agent
  rename (via `useInlineRename`), `ProjectSetupWizard` project name.
- Free text: `CommitModal` message + description, `FeedbackModal` title +
  description, `DiffCommentCard` comment.

### Deliberately not adopted

Search inputs (settings, themes, terminal, diff, `SearchableSelect`), the
browser URL and find bars, worktree path, setup/teardown scripts, keybindings,
Linear/remote-control credentials, branch name fields,
`DeleteWorktreeDialog` confirmation, and `ProjectSettingsPage` fields that
use `defaultValue` + ref-read-on-blur for non-name data.

### Branch names drop emoji

`sanitizeBranchName` in both `src/utils/branch-name.ts` and
`electron/branch-name.ts` strips `\p{Extended_Pictographic}`, emoji
modifiers, variation selectors (U+FE0F) and ZWJ (U+200D) before it collapses
separators. `🚀 Launch` → `Launch`, not `-Launch`. Display names keep their
emoji.

### Rule

Add to `.claude/rules/ui-components.md`: "Text inputs holding user-authored
names or prose: use `<EmojiInput>` / `<EmojiTextarea>` from
`ui/EmojiAutocomplete`. Not for search, URLs, paths, code or credentials."

## Consequences

- Every adopted field gets `:shortcode` emoji through one implementation, and
  new fields adopt it with an import swap.
- Callers keep their existing `onChange` and commit logic because insertion
  dispatches a real `input` event.
- About 1MB of emoji JSON is added as a lazily loaded chunk. The first trigger
  after launch waits one dynamic import before suggestions show; later
  triggers are instant.
- **Risk:** the native-setter + `input` event trick depends on React's value
  tracking internals. It is widely relied on (Testing Library), but a React
  major could change it. It is isolated in one helper in the hook.
- **Risk:** a portalled popover inside a modal Radix `Dialog` has to stay
  inside the dialog's React tree (the hook renders it next to the field), or
  the dialog's outside-pointer handling closes the dialog when an option is
  clicked. Verify in `NewFolderDialog` and `CommitModal`.
- **Risk:** Escape handling in nested layers. With the list open, Escape must
  close only the list. The hook consumes the React event, and Radix's
  document-level Escape goes to the topmost `DismissableLayer`, which is the
  popover. Verify inside a Dialog.
- Emoji now reach names more easily. Anything that derives a filesystem or git
  identifier from a name must sanitize it. `sanitizeBranchName` is fixed here.
  `defaultWorktreePath` already strips non-ASCII.
- No skin tones, no recents, no full grid picker. Any of these can be added
  later on top of the same index.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
