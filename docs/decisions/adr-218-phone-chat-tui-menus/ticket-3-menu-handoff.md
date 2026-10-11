---
title: Terminal handoff with a key bar and auto-return
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Terminal handoff with a key bar and auto-return

ADR-218 D3. Read the ADR first, and ADR-215 D7 for how the phone shows the chat and terminal views.

**Store** (`src/components/phone/ChatPane/usePaneChatView.ts`):
- Add `handoffs: Record<string, { name: string; startedAt: number }>` (in memory only) to `PaneChatViewState`.
- `startMenuHandoff(paneId, name)`: records the handoff with `Date.now()` and calls `setPaneChatView(paneId, "terminal")`.
- `endMenuHandoff(paneId, opts?: { returnToChat?: boolean })`: removes it, and with `returnToChat` calls `setPaneChatView(paneId, "chat")`. A no-op when there is none.
- `usePaneMenuHandoff(paneId)` selector hook.

**Composer**: in `ChatComposer.tsx` `send()`, replace `setPaneChatView(paneId, "terminal")` for menu-opening commands with `startMenuHandoff(paneId, name)`.

**Auto-return** (`ChatPane.tsx`, `chat-entries.ts`):
- Pure `endsMenuHandoff(handoff, entry): boolean` in `chat-entries.ts`: true when `entry.kind === "command"`, `entry.name === handoff.name` and `Date.parse(entry.ts) >= handoff.startedAt - 2000`. A `ts` that doesn't parse → false.
- In `ChatPane`'s `onEntry` callback, read the handoff from the store (`usePaneChatViewStore.getState()`, not a hook: the callback is mount-time) and call `endMenuHandoff(paneId, { returnToChat: true })` when the predicate holds. Also check entries from a history refetch if that's cheap, but live entries are what matters.

**Key bar** (`src/components/phone/ChatPane/MenuKeyBar.tsx` + CSS in `PaneView.module.css` or a new module):
- Props: `paneId`, `onBackToChat`. A row of `ui/Button`s: ↑ ↓ ⏎ Esc Tab (use lucide icons where they exist: `arrow-up`, `arrow-down`, `corner-down-left`. Esc and Tab are text), and a primary **Back to chat** at the end. Each key calls `window.electronAPI.chat.key(paneId, key)`. Swallow errors quietly, or show a small inline note. Each key has an `aria-label`. `data-testid="menu-key-bar"` on the bar, `menu-key-<key>` on each key.
- Buttons at least 44px tall. Respect `env(safe-area-inset-bottom)`. Use `onPointerDown` with `preventDefault` or similar so tapping a key doesn't steal focus from or blur the terminal, if that matters for xterm. Check what works.
- Use theme tokens. Check other phone CSS modules for the variables in use.

**LeafPane** (`src/components/workspace-panes/LeafPane.tsx`):
- Phone only: when `usePaneMenuHandoff(paneId)` is set and the terminal is showing (`!showChat`), render `MenuKeyBar` over the bottom of the terminal area, and add bottom padding to the terminal container equal to the bar's height so the last TUI rows stay visible. Avoid resizing loops: a fixed bar height (CSS variable) is fine. Check how xterm fit reacts to padding changes and keep it to one resize on show and one on hide.
- When the pane's `chatTranscript` changes while a handoff exists, call `endMenuHandoff(paneId, { returnToChat: true })` (the `/resume` case).
- `onBackToChat` → `endMenuHandoff(paneId, { returnToChat: true })`.

**Overflow menu** (`src/components/phone/PhoneOverflowMenu.tsx`): when the user flips the Chat | Terminal view, call `endMenuHandoff(paneId)` (without `returnToChat`) in addition to the existing switch.

**Tests**: unit tests for `endsMenuHandoff` (in the existing `chat-entries` tests) and the store transitions. Extend `src/components/phone/ChatPane/__tests__/ChatPane.test.ts` if it can cover the auto-return cheaply.

## Files to touch
- `src/components/phone/ChatPane/usePaneChatView.ts`
- `src/components/phone/ChatPane/ChatComposer.tsx`
- `src/components/phone/ChatPane/ChatPane.tsx`
- `src/components/phone/ChatPane/chat-entries.ts`
- `src/components/phone/ChatPane/MenuKeyBar.tsx` (new)
- `src/components/phone/ChatPane/PaneView.module.css` (or a new CSS module)
- `src/components/workspace-panes/LeafPane.tsx`
- `src/components/phone/PhoneOverflowMenu.tsx`
- tests under `src/components/phone/ChatPane/__tests__/`
