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

# ADR-215: The phone chat view — a transcript mirror with answerable pickers

Builds on ADR-178 (web app and single bridge) and ADR-181 (phone layout).
Reading ADR-181 D6 first is assumed: this ADR deliberately walks back part of
its "accepted cost".

## Context

On a phone, a Claude pane is the desktop's xterm grid followed at the
desktop's `cols×rows` and shrunk to fit (ADR-178 D5). Claude Code's TUI is
drawn for a wide terminal: at phone scale the text is tiny, wraps badly, and
panning sideways to read a reply is the normal case. ADR-181 D6 also left the
phone with no Esc, Tab or arrow keys, so **a phone cannot answer an
AskUserQuestion picker or approve a plan** — the moment a user most wants to
act from their phone is the one they can't.

Three routes were considered:

1. **Mirror Claude's JSONL transcript** into a chat view, keep the PTY as the
   source of truth, and send input back as keystrokes.
2. **Run Claude headless** (`claude -p --output-format stream-json`, or the
   Agent SDK) so Manor owns the conversation. This gives token streaming and
   native permission callbacks, but the desktop would lose the real TUI or
   need a second chat UI. It would also break how agents launch, resume and
   report hooks (`electron/agent-connectors.ts`, ADR-209). It is a rewrite of
   what an agent *is* in Manor.
3. **Let the phone own the winsize** so the TUI reflows to phone width. This
   is cheap, but it resizes the desktop pane under its user, and the phone
   still sees a terminal.

What exists that route 1 can stand on:

- Manor's hook script (`electron/scripts/agent-hook.js`) already maps every
  Claude hook to a pane (`MANOR_PANE_ID`) and a session (`session_id`). The
  payload also carries `transcript_path`, which the script drops today.
- `AgentInfo` (`electron/agent-persistence.ts`) records `agentSessionId`,
  `paneId` and `hostId` per agent.
- The bridge (`electron/bridge/events.ts`, `SUBSCRIPTIONS`) already carries
  per-pane streams (`pty.*`) and per-machine ones (`agents.*`) to the phone
  over IPC, WebSocket or the relay.
- `pty.write` (`electron/bridge/handlers/pty.ts`) is the phone's keyboard.

A sample transcript confirms what the picker needs: an `AskUserQuestion`
`tool_use` block, with its full `questions[]` (question, header, options,
`multiSelect`), is written to the JSONL **when Claude asks**. Its
`tool_result` is written only when the question is answered. So "a `tool_use`
for a picker tool with no `tool_result` yet" means Claude is waiting on the
user, and the payload says exactly what to draw.

## Decision

**D1 — Route 1: the transcript is the chat's source, and the PTY stays the
truth.** Nothing about how Claude runs changes. The desktop is untouched. The
chat view is a *reader* of Claude's transcript plus a *writer* of keystrokes
to the same PTY the terminal view shows. Either view can be used at any
moment, and both describe one session.

**D2 — `transcript_path` is captured from hooks and stored on the agent.**
`agent-hook.js` forwards `payload.transcript_path` as a `transcriptPath` URL
parameter (alongside `sessionId`). `parseAgentHookEvent` carries it on the
event, and the agent record gains `transcriptPath: string | null`, set
whenever a hook supplies one. Claude can switch transcripts mid-pane (`/clear`,
resume), so the latest value wins rather than being set once.

**D3 — A pure transcript parser.** `electron/chat-mirror/transcript.ts` turns
JSONL lines into `ChatEntry` values:

- `user`: a prompt the user typed. Hook-injected and system lines are skipped.
- `assistant`: text blocks.
- `tool`: a `tool_use` paired with its `tool_result` by id. It shows the tool
  name and a one-line summary, plus a status (pending / ok / error).
- `question`: an `AskUserQuestion` `tool_use` with its `questions[]` and its
  answer once the result arrives.
- `plan`: an `ExitPlanMode` `tool_use` with its plan text and outcome.

Thinking blocks and sidechain (subagent) lines are dropped. **Unknown line
types and unknown block types are skipped, never thrown on**: the transcript
format is not a public API, and a format change must make the chat lossy, not
broken.

**D4 — A per-pane mirror service in main, exposed as a `chat` bridge
namespace.**

- `chat.getHistory(paneId)` returns the parsed entries, or a typed
  `unavailable` reason (no transcript yet, not a Claude pane, remote host).
- `chat.onEntry` is a pane-keyed subscription. It is added to `SUBSCRIPTIONS`
  and keyed like `pty.*`, and it pushes new or updated entries.
- `chat.send(paneId, text)` writes the text and then `\r` to the PTY.
- `chat.interrupt(paneId)` writes Esc. This closes ADR-181 D6's "cannot
  interrupt" gap.
- `chat.answer(paneId, toolUseId, answer)` is covered by D5.

The service tails the file by byte offset and handles partial last lines. It
watches only while at least one subscriber is attached. **v1 reads local-host
transcripts only.** For an agent on a remote host, `getHistory` returns
`unavailable: "remote"` and the phone keeps the terminal view. Reading through
the host backend's exec is a follow-up, not a blocker.

**D5 — Answers are keystrokes, encoded by one pure function and verified
before sending.** `encodePickerAnswer(question, answer)` turns a choice into
the bytes Claude Code's picker expects:

- one option: arrows, then Enter
- "Other": move to Other, type the text, then Enter
- multi-select: toggle each choice, then submit
- several questions in one picker: answer each, then confirm on the submit
  screen

The exact sequences are **established empirically against a real `claude` by
ticket 1**, not guessed. They are pinned by unit tests on the encoder.

**Spike findings (ticket 1, Claude Code 2.1.296).** Every AskUserQuestion
shape was confirmed by reading the `tool_result` back from the transcript:

- single choice: Down×i, Enter
- Other: Down to "Type something.", the text, Enter
- multi-select: Enter toggles each choice, Tab to the Submit tab, Enter
- several questions: answer each (Enter advances), then Enter on Submit

ExitPlanMode is different. Its dialog has two shapes: "Ready to code?" with
three options when there is a plan, and "Exit plan mode?" (Yes / No) without
one. The options also depend on the permission mode. Option 1 always
approves, so **the chat can approve a plan, and anything else ("keep
planning", "tell Claude what to change") goes to the terminal**. Pressing a
fixed index to reject could land on "Yes, manually approve edits". Free text
on a multi-select question is also unverified, so the encoder refuses it and
the card sends it to the terminal.

`chat.answer` refuses (`stale`) unless that `toolUseId` is still the newest
unanswered picker for the pane. A double tap, or an answer the desktop already
gave, must never type into whatever screen comes next. After sending, if no
`tool_result` for that id appears within a timeout, the entry is marked
`needs-terminal` instead of being retried.

**D6 — What the chat can't answer, it hands to the terminal.**

- Permission prompts are rare because agents run with
  `--dangerously-skip-permissions`.
- Slash-command menus and any picker the parser doesn't recognise show a
  "Claude needs you — open terminal" banner.
- The trigger is the agent's existing `requires_input` status (`Notification`
  and `PermissionRequest` hooks) when no answerable `question`/`plan` entry is
  pending.

The terminal view is always one tap away.

**D7 — Phone-only, per pane, terminal by default until a transcript exists.**

- In phone mode (`useLayoutMode() === "phone"`), a leaf whose pane has a
  Claude agent with a `transcriptPath` gets a Chat | Terminal toggle.
- Chat is the default once available. The choice is remembered per pane in
  `localStorage`, which is a per-viewer convenience.
- Both views stay mounted, the terminal hidden. Switching remounts nothing
  and changes no geometry, as in ADR-181 D1.
- The desk renderer never shows the toggle.

The composer:

- is an `<EmojiTextarea>`, since it holds user prose
- sits pinned above the soft keyboard (reusing `KeyboardLift`)
- has Send and Stop buttons

Tool entries are collapsed one-line cards that expand on tap.

## Consequences

**Gets better.**

- A phone can read a Claude session at a readable size, answer its questions,
  approve its plans, and interrupt it.
- The desktop, agent launch, resume and hooks are unchanged apart from one
  extra hook field.

**Gets harder / risks.**

- **The transcript format is private to Claude Code.** A rename or a new
  block shape degrades the chat until the parser catches up. The skip-unknown
  rule (D3) keeps that lossy rather than fatal, and the terminal is one tap
  away.
- **Picker keystrokes are coupled to Claude Code's TUI.** If the key scheme
  changes, answers could select the wrong option. Mitigations:
  - the encoder is one small module with tests
  - stale-guarding and the `needs-terminal` timeout (D5) bound the damage
  - Claude Code version bumps should re-run ticket 1's spike script
- **No token streaming.** Text arrives per message, not per token. This is
  acceptable for checking in from a phone.
- **Remote-host agents get no chat in v1** (D4).
- ADR-181 D6's "no composer" is reversed for Claude panes in chat mode only.
  Plain shells keep typing into xterm.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
