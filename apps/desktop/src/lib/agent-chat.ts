/**
 * What a pane's chat does differently per **Agent kind**: what it calls the
 * agent, which `/` menu it offers, the keys that stop a turn, and whether a
 * picker in the transcript can be answered from the chat. Pure data with no
 * imports, so main's chat mirror (`electron/chat-mirror`), the bridge's
 * `chat` handlers and the renderer read one record.
 *
 * Reading a kind's transcript and typing its prompt belong to its
 * `TranscriptAdapter` (`electron/chat-mirror/adapters`), which only main has.
 */

type AgentKind = "claude" | "codex" | "pi" | "opencode";

export interface AgentChat {
  /** What the chat calls the agent: "Claude", "Codex", "pi", "opencode". */
  name: string;
  /**
   * The composer's `/` menu: Claude Code's built-in commands plus the skills
   * its transcript lists (`chat-mirror/builtin-commands.ts`), or none.
   */
  commands: "claude" | "none";
  /** Commands that leave the conversation for a new session (`/clear`). */
  clearCommands: readonly string[];
  /** What Stop types into the PTY: one write each, in order. */
  interruptKeys: readonly string[];
  /** Whether a question or plan in its transcript can be answered by typing
   *  into the PTY (`chat.answer`). Otherwise it is answered in the terminal. */
  answersPickers: boolean;
}

const ESC = "\x1b";

const AGENT_CHATS: Record<AgentKind, AgentChat> = {
  claude: {
    name: "Claude",
    commands: "claude",
    clearCommands: ["clear", "reset", "new"],
    interruptKeys: [ESC],
    answersPickers: true,
  },
  codex: {
    name: "Codex",
    commands: "none",
    clearCommands: [],
    interruptKeys: [ESC],
    answersPickers: false,
  },
  pi: {
    name: "pi",
    commands: "none",
    clearCommands: [],
    interruptKeys: [ESC],
    answersPickers: false,
  },
  opencode: {
    name: "opencode",
    commands: "none",
    clearCommands: [],
    // One Esc only arms opencode's interrupt; the second stops the turn.
    interruptKeys: [ESC, ESC],
    answersPickers: false,
  },
};

/** For an agent of no kind Manor knows: nothing kind-specific is offered. */
const UNKNOWN_AGENT_CHAT: AgentChat = {
  name: "Agent",
  commands: "none",
  clearCommands: [],
  interruptKeys: [ESC],
  answersPickers: false,
};

/**
 * The agent kinds whose transcript the chat can read. A kind is added here
 * once its `TranscriptAdapter` exists (`adapterFor` answers for exactly
 * these).
 */
export const CHAT_KINDS: ReadonlySet<string> = new Set<AgentKind>(["claude"]);

/** Whether an agent of `kind` gets a chat at all. */
export function hasChat(kind: string | null | undefined): boolean {
  return kind != null && CHAT_KINDS.has(kind);
}

/** The chat record for `kind`; a neutral one for no kind or an unknown one. */
export function agentChat(kind: string | null | undefined): AgentChat {
  return kind != null && Object.prototype.hasOwnProperty.call(AGENT_CHATS, kind)
    ? AGENT_CHATS[kind as AgentKind]
    : UNKNOWN_AGENT_CHAT;
}
