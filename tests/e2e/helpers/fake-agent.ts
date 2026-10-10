import path from "path";

/**
 * The fake agent CLI the e2e suite points projects at.
 *
 * The script itself is `fake-agent.sh` next to this file — a real script, not
 * a string built here. It needs no per-test state, so nothing is generated or
 * copied: tests hand its path to Manor as a project's agent command.
 */

/** Absolute path to the script. Quote it when embedding in a shell command. */
export const FAKE_AGENT = path.join(__dirname, "fake-agent.sh");

/** Printed once at startup. Assert on this to know the session is live. */
export const FAKE_AGENT_BANNER = "fake-agent ready";

/** Prefix the fake agent echoes back for anything sent to it. */
export const FAKE_AGENT_ECHO = "received:";

/**
 * Send this and the agent ends its turn without asking for anything back, so
 * the session parks in `responded` rather than `requires_input`. Any other
 * message re-arms the permission prompt.
 */
export const FAKE_AGENT_HUSH = "hush";

/**
 * Send this and the agent holds `thinking` (the UserPromptSubmit hook) for
 * five seconds before its Stop hook parks it in `responded` — long enough for a
 * test to observe the in-between status, which `FAKE_AGENT_HUSH`'s
 * back-to-back hooks are too fast to poll for (ADR-184).
 */
export const FAKE_AGENT_SLOW_HUSH = "slow-hush";

/**
 * Send this and the agent ends its session cleanly: a SessionEnd hook fires
 * and the process exits, the way a real agent CLI does when the user quits
 * it.
 */
export const FAKE_AGENT_EXIT = "exit";

/**
 * Send this and the agent draws two identical rows wider than a phone can
 * show without wrapping — ADR-177's fixture for "the grid is not reflowed".
 */
export const FAKE_AGENT_RULER = "ruler";
/** Exactly what each row `FAKE_AGENT_RULER` draws, so a test can assert on
 *  the row itself rather than duplicating the script's width here. */
export const FAKE_AGENT_RULER_ROW = "#".repeat(120);

/**
 * `fake-agent-transcript.sh`: the fake agent for the phone chat view
 * (ADR-215). It also writes a Claude-shaped JSONL transcript and reports it
 * as `transcriptPath`, which is what flips a phone pane to chat — so it is a
 * separate script, opt-in, rather than a mode every fake agent gets.
 *
 * Arguments: `<transcript.jsonl> <input.log> [title]`. The input log is every
 * byte the agent read, raw — the only record of what `chat.answer` and
 * `chat.send` typed, since `chat.*` calls are not audited.
 */
export const FAKE_AGENT_TRANSCRIPT = path.join(__dirname, "fake-agent-transcript.sh");

/** What the transcript agent writes before it asks its question. */
export const FAKE_CHAT_PROMPT = "Help me pick an option";
export const FAKE_CHAT_REPLY = "Here are three ways to go.";

/** The AskUserQuestion it leaves open: one single-select question, three options. */
export const FAKE_CHAT_QUESTION = "Which option should the fake agent take?";
export const FAKE_CHAT_OPTIONS = ["Option 1", "Option 2", "Option 3"] as const;
