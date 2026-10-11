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

# ADR-218: TUI menus from the phone chat

## Context

ADR-217 D5 handles commands that open a menu in Claude Code's TUI (`/model`, `/config`, `/resume`, …) by sending the command and then switching the pane to the terminal (`ChatComposer.tsx`, `setPaneChatView(paneId, "terminal")`). On a phone that is a dead end:

- The menu needs arrow keys, Enter and Esc. A phone's soft keyboard has no arrows, so the menu is hard to drive once you're there.
- When the menu closes, you stay in the terminal and have to find the overflow menu to get back to the chat.
- Some of these commands don't need a menu at all. Claude Code v2.1.296 declares an `argumentHint` on many of them, and with an argument they act at once: `/model sonnet`, `/effort high`, `/fast on`, `/config key=value`, `/add-dir <path>`, `/resume <id or search>`, `/mcp reconnect <server>`. But `isInteractive` looks only at the name, so even a typed `/model sonnet` switches to the terminal.

### What the transcript shows

Checked against local transcripts (v2.1.281–v2.1.296): a menu command's transcript lines are written **when the menu completes, not when it opens**. The caveat, the `<command-name>/model</command-name>` line and its `<local-command-stdout>Set model to …</local-command-stdout>` all carry the same timestamp, after the pick. So a `command` chat entry for the command we sent means its menu has closed. We didn't find a transcript for a menu dismissed with Esc, so we don't know whether one writes a line.

## Decision

Two parts. Commands with a fixed set of arguments get a native picker in the chat, so there's no TUI. Everything else still goes to the terminal, with a key bar, and comes back to the chat on its own.

### D1. Command metadata says when a menu opens

`ChatCommand` (`electron/chat-mirror/builtin-commands.ts`) gains two optional fields. Existing fields keep their meaning, so an older phone ignores the new ones.

```ts
type ChatCommand = {
  name: string;
  description: string;
  source: "builtin" | "skill";
  /** Sent bare, opens a menu in the TUI that the chat can't show. */
  interactive?: boolean;
  /** With an argument it acts at once, no menu (`/model sonnet`). */
  argSkipsMenu?: boolean;
  /** Fixed arguments the phone can offer as a native picker (D2). */
  choices?: { value: string; label: string; description?: string }[];
};
```

New pure helper `opensMenu(command: ChatCommand | undefined, name: string, args: string): boolean`: true when the command is interactive and either `args` is empty or `argSkipsMenu` isn't set. For an unknown command it falls back to `isInteractiveCommand(name)` with the same args rule, using the built-in entry. `useSlashCommands.isInteractive(name)` becomes `opensMenu(name, args)`. The composer passes the args that follow the first word (`firstWordCommand` gains a sibling, `splitCommand(text) → { name, args } | null`).

List changes, from the v2.1.296 binary's command table:

| command | interactive | argSkipsMenu | choices |
|---|---|---|---|
| `model` | yes | yes | `default`, `fable`, `opus`, `sonnet`, `haiku` |
| `effort` (new) | yes | yes | `low`, `medium`, `high`, `xhigh`, `max` |
| `fast` (new) | yes | yes | `on`, `off` |
| `config` | yes | yes (`key=value`) | none |
| `resume` | yes | yes | none |
| `add-dir` | yes | yes | none |
| `mcp` | yes | yes | none |
| `agents` | dropped (hidden/removed in v2.1.296) | | |

The implementer confirms the choice values against the installed binary (e.g. `strings` on `~/.local/share/claude/versions/<v>` and the `--model` help text) and updates the header comment's version.

### D2. A choice sheet replaces the `/` menu for commands with `choices`

Picking a command that has `choices` from the `/` menu (tap, Enter or Tab) opens `CommandChoiceSheet.tsx` where the menu was, above the composer. It doesn't fill in `/name `.

- Each choice is a row (`Button`): the label and a muted description. Tapping one sends `/<name> <value>` right away with `chat.send` and clears the composer. That's one tap, and it goes through the existing send path, so the command chip shows up in the history as usual.
- An "Other…" row turns the sheet into the composer prefilled with `/<name> ` and the caret after it, for a value the list lacks (e.g. a full model id).
- An "Open menu in terminal" row sends `/<name>` bare, which takes the D3 path.
- Esc, or tapping outside the sheet, closes it and leaves the composer as it was.
- Arrow keys and Enter work as they do in the `/` menu, for a hardware keyboard.

Typing `/model sonnet` by hand and sending it works too. Under D1 it no longer switches to the terminal.

### D3. The terminal with a key bar, back to the chat on its own

When a sent message still opens a menu (`opensMenu` is true), the composer:

1. Sends it, as now.
2. Calls a new `startMenuHandoff(paneId, name)` in `usePaneChatView.ts`. It records `{ name, startedAt }` in a new in-memory `handoffs` map in the same store and switches the view to `terminal`.

While a pane has a handoff and shows the terminal, `LeafPane` (phone only) draws `MenuKeyBar.tsx` over the bottom of the terminal: **↑ ↓ ⏎ Esc Tab** and a **Back to chat** button, as `ui/Button`s, at least 44px tall, above the safe area. Each key calls a new bridge method `chat.key(paneId, key)`, with `key` in a fixed enum `"up" | "down" | "left" | "right" | "enter" | "esc" | "tab" | "space"`. The handler maps it to its escape sequence and writes it to the PTY. Like `chat.send` it's a keystroke, so it isn't audited. A fixed enum keeps it from becoming a second `pty.write`.

The handoff ends, and the view goes back to `chat`, on whichever comes first:

- **The command lands.** `ChatPane` stays mounted while hidden. When `onEntry` delivers a `command` entry whose `name` matches the handoff and whose `ts` is at or after `startedAt` (less 2s of clock slack), it calls `endMenuHandoff(paneId, { returnToChat: true })`. The check is a pure function in `chat-entries.ts`, so tests can pin it. By the Context finding, that entry means the menu completed.
- **Back to chat**, tapped on the key bar.
- **The user flips the view** in `PhoneOverflowMenu`. This ends the handoff without switching anything else.
- **A new transcript** (`/resume` picks a session, so the chat remounts under a new key). `LeafPane` ends any handoff whose pane's transcript changed. `/resume` then lands you in the chat for the resumed session, which is what you'd want.

If a menu closes without writing a line (likely an Esc dismissal), the key bar stays until you tap Back to chat.

We don't shrink the terminal into a sheet. Resizing the PTY reflows the TUI and Claude Code redraws, which is worse than a full-height terminal with a bar over its bottom rows. The bar adds bottom padding to the terminal while it's shown, so it never covers the menu's last row.

### D4. Tests

- Unit: `opensMenu` (bare, with args, unknown name, skill overriding a built-in), `splitCommand`, the handoff-done predicate (matching name, older `ts`, other command, non-command entry), `chat.key` mapping and rejecting an unknown key, and the store's start/end transitions.
- Component: the choice sheet sends `/<name> <value>` on tap, "Other…" prefills, Esc restores.
- E2E (`tests/e2e/phone-chat.spec.ts`): pick `/model`, tap Sonnet, and the PTY gets `/model sonnet` and Enter, while the view stays on chat. Send `/config` bare, and the view switches to the terminal with `menu-key-bar`. Tap ↓ and the PTY gets `\x1b[B`. Append a `/config` command line to the fake transcript, and the view returns to chat with the bar gone. ADR-217's Test 4 (interactive → terminal) is updated to fit.

## Consequences

**Better**
- `/model`, `/effort` and `/fast`, the menu commands you'd use most from a phone, become one tap with no terminal at all.
- A typed command with an argument (`/model opus`, `/config key=value`) no longer throws you into the terminal.
- When a menu does need the terminal, it can be driven without a hardware keyboard, and the chat comes back once it closes.
- No screen scraping. Every signal comes from the transcript and the command table, which the chat already depends on.

**Harder / risks**
- The choice lists are hard-coded and go stale. A new model alias needs a code change, though "Other…" always works.
- The auto-return relies on menu commands writing their line at completion. If Claude Code starts writing it when the menu opens, the bar would close too early: you'd land on the chat with the menu still open in the terminal. The overflow menu still gets you back, and the predicate's test fixture records the order we saw.
- An Esc-dismissed menu probably doesn't trigger auto-return. Back to chat covers it.
- `chat.key` is a new write path into the PTY. It is restricted to eight navigation keys and is no more powerful than `chat.interrupt` + `chat.send`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
