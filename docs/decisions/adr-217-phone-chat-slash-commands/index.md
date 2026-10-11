---
type: adr
status: proposed
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

# ADR-217: Slash commands and skills in the phone chat

## Context

The phone chat (ADR-215, ADR-216) sends a message by typing it into the pane's PTY (`chat.send` → `encodeChatMessage` → `backend.pty.write`). A message such as `/review` or `/simplify src/foo.ts` therefore already reaches Claude Code as a slash command. Three things are missing around that:

1. **No discovery.** `ChatComposer.tsx` is a plain `EmojiTextarea`. You have to remember every command and skill name, and type it on a phone keyboard.
2. **Commands vanish from the history.** `TranscriptParser` drops any user text starting with `<command-` or `<local-command` (`transcript.ts:46`, `META_PREFIXES`). A command run from either view leaves a gap in the chat: Claude's reply appears with nothing before it.
3. **Partial names can run the wrong thing.** Typing `/` opens Claude Code's own autocomplete in the TUI, and Enter picks the highlighted item. A partial name may run a different command. A full name is safe.

Some commands (`/model`, `/config`, `/resume`, `/mcp`, …) open a menu in the TUI. The chat cannot show or drive it.

### What the transcript gives us

Claude Code doesn't publish its command list, but it writes the session's skill list into the transcript JSONL as an attachment line:

```json
{"type":"attachment","attachment":{"type":"skill_listing","isInitial":true,
  "skillCount":67,"names":["caveman","diagnose",…,"anthropic-skills:pdf"],
  "content":"- caveman: Ultra-compressed…\n- diagnose: Disciplined…"}}
```

Facts checked against local transcripts (Claude Code v2.1.281–v2.1.296):

- One `isInitial: true` listing appears in every non-stub session. It is written with the first user turn, so a fresh session has none until then.
- Later listings have `isInitial: false` and carry **only the added skills** (e.g. 1 name after a plugin loads). They are deltas, not replacements.
- `names` holds project, user, plugin (`plugin:skill`) and bundled skills (`simplify`, `code-review`, `loop`, `init`). It doesn't hold built-in commands (`/clear`, `/compact`, `/model`…). It probably also lacks skills marked `disable-model-invocation`, since the listing is what the model sees.
- `content` is `- name: description` lines.

A slash command run in the TUI is written as a non-meta user line with string content. A skill puts `<command-message>` first, a built-in puts `<command-name>` first:

```
<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>
<command-message>mattpocock-skills:research</command-message>\n<command-name>/mattpocock-skills:research</command-name>\n<command-args>how are …</command-args>
```

A local command's output is a later user line `<local-command-stdout>Login successful</local-command-stdout>`, sometimes preceded by a `<local-command-caveat>` line.

The format is private to Claude Code, so every part of this may change. The parser's rule stays the same: a format change makes the chat lossy, not broken.

## Decision

### D1. The parser tracks the session's skills

`TranscriptParser` (`electron/chat-mirror/transcript.ts`) accepts `type: "attachment"` lines whose `attachment.type === "skill_listing"` (non-sidechain only, as today). It keeps a `Map<name, description>`:

- `isInitial: true` clears the map, then adds.
- Otherwise it adds or overwrites entries (a delta).
- Descriptions come from parsing `content` lines `- <name>: <description>`. A name in `names` with no matching line gets `""`. If `names` is missing, the names parsed from `content` are used.
- Anything malformed is skipped.

New method `skills(): ChatSkill[]` (sorted by name) and `hasSkillListing(): boolean`. These don't produce `ChatEntry`s and are never published as `chat.entry`.

### D2. A `command` chat entry

A user line whose text matches `<command-name>/X</command-name>`, in either tag order, becomes:

```ts
{ kind: "command"; id; ts; name: string /* without "/" */; args: string; output?: string }
```

`args` comes from `<command-args>`, trimmed. A following `<local-command-stdout>` line fills `output` on the most recent `command` entry, capped at `MAX_DETAIL`, and is republished as an update (same id, new object). Empty stdout is ignored. `<local-command-caveat>` and `<system-reminder>` stay dropped. The meta line that expands a skill's body is already dropped by `isMeta`.

On the phone, `ChatEntryView` draws it as a right-aligned chip in the user column (`/name args`), expanding to `output` on tap like `ToolEntry`. A phone running an older build already returns `null` for an unknown kind.

### D3. `chat.getCommands(paneId)`, fetched when needed

New bridge method in `electron/bridge/handlers/chat.ts`:

```ts
type ChatCommand = {
  name: string;          // "review", "anthropic-skills:pdf", "clear"
  description: string;
  source: "builtin" | "skill";
  /** Opens a menu in the TUI that the chat can't show. */
  interactive?: boolean;
};
type ChatCommands =
  | { ok: true; commands: ChatCommand[]; skillsKnown: boolean }
  | { ok: false; reason: ChatUnavailableReason };
```

`ChatMirror.getCommands(paneId)` resolves and reads, as `getHistory` does, then merges the built-ins (D4) with the parser's skills. A skill whose name matches a built-in replaces the built-in.

The phone calls it the first time the composer sees a `/` query, and refetches when the menu opens after a new `chat.entry` arrived. There is no push event: the list changes rarely, and a fetch costs one read the mirror would do anyway. It is a read, so it isn't audited.

**Before the first prompt, and across `/clear`.** `/clear` and resume move the pane to a new transcript, and the mirror resets its parser (`usePath` → `reset`). The new transcript has no listing until its first prompt. `PaneMirror` keeps `lastSkills` (the most recent non-empty `skills()`) across resets of the same pane, and `getCommands` falls back to it. `skillsKnown` is false only when neither exists. The phone then shows built-ins plus a muted line: "Skills appear after your first message." We don't scan skill folders on the host. It would duplicate Claude Code's resolution rules (plugins, precedence, enablement) and still miss what the session actually loaded.

### D4. Built-in commands are a hard-coded list

`electron/chat-mirror/builtin-commands.ts` exports `BUILTIN_COMMANDS: ChatCommand[]`: name, one-line description and `interactive` flag. The header comment records the Claude Code version it was checked against.

- Starting set, prompt-like: `clear`, `compact`, `cost`, `context`, `export`, `pr-comments`, `release-notes`, `review`, `security-review`, `todos`.
- Starting set, interactive: `model`, `config`, `resume`, `mcp`, `agents`, `permissions`, `hooks`, `memory`, `login`, `logout`, `doctor`, `status`, `plugin`, `theme`, `help`, `add-dir`, `ide`, `bashes`.

The implementer checks the list against the installed `claude` (`/help`) and drops what doesn't exist. It's a convenience list. A command missing from it can still be typed.

### D5. A `/` menu in the composer

New `src/components/phone/ChatPane/useSlashCommands.ts` and `SlashCommandMenu.tsx`.

- **When it opens.** The textarea's text starts with `/`, and the caret is inside the first word with no whitespace before it. The query is the text after `/` up to the caret. A command is only recognised at the start of a message, which matches Claude Code.
- **Matching.** Case-insensitive. Prefix matches on the name, or on the part after `plugin:`, rank first. Substring matches follow, then description matches. At most 8 rows. Each row shows `/name`, the description truncated to one line, and an "Opens in terminal" tag for `interactive`.
- **Picking.** Tapping a row, or Enter / Tab with a hardware keyboard, replaces the query with `/name ` (trailing space) and closes the menu. Esc closes it. Arrow keys move the selection. The menu sits above the composer, as `EmojiTextarea`'s popover does. Use `ui/` components (`Button` for rows). Emoji autocomplete stays on; its `:` trigger doesn't clash with `/`.
- **Interactive commands.** Sending a message whose first word is a command flagged `interactive` sends it as normal, then switches the pane to the terminal view (`setPaneChatView(paneId, "terminal")`), because its menu is only there.

Because a picked command is always a full name, sending it never relies on Claude Code's own autocomplete choosing the right item (Context point 3).

### D6. Tests

- Unit tests: parser listing merge (initial/delta/malformed), the `command` entry in both tag orders, stdout attachment, the mirror's `getCommands` with the `lastSkills` fallback across a path change, and the menu's matcher as a pure function.
- E2E (`tests/e2e/phone-chat.spec.ts`): the fake agent's transcript gains a `skill_listing` line and a command line. The phone opens the menu on `/`, filters, picks, sends `/name args`, and the PTY receives it. The history shows the chip.

## Consequences

**Better**
- Commands and skills are discoverable and quick to type on a phone, with the same names and descriptions the session actually loaded, for local and remote panes alike (the transcript already flows through `TranscriptSource`).
- The chat history stops having gaps where commands ran, and `/login`-style output becomes visible.
- No new push event, no host file scanning, and no new write path. Sending is still `chat.send`.

**Harder / risks**
- Depends on an undocumented attachment format. If Claude Code drops or renames `skill_listing`, the menu falls back to built-ins only. Nothing breaks, but skills disappear quietly. The `transcript.test.ts` fixtures pin the format we saw.
- A fresh session in a new pane has no skills until its first prompt. `lastSkills` covers `/clear` and resume in the same pane, but not a brand-new pane.
- Skills hidden from the model (`disable-model-invocation`) probably won't be listed. They can still be typed.
- The built-in list goes stale as Claude Code adds or removes commands. It needs an occasional check against `/help`.
- Interactive commands still need the terminal. The chat only routes you there.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
