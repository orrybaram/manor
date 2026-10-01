import { DEFAULT_AGENT_COMMAND } from "./agent-command";

/**
 * Agent-agnostic harness kinds `send_to_session`
 * can drive. Mirrors `AgentKind` in `electron/terminal-host/types.ts` at the
 * points that matter for launch/interrupt behavior.
 */
type HarnessKind = "claude" | "codex";

export interface HarnessAdapter {
  kind: HarnessKind;
  /** Full boot command for this CLI. */
  launchCommand(): string;
  /** Raw pty bytes that end the harness's current turn (graceful cancel). */
  interruptSequence(): string;
  /** Prompt-ready detection for steering, given a `lastAgentStatus`. */
  isIdle(status: string | null): boolean;
}

const IDLE_STATUSES = new Set(["requires_input", "responded", "idle"]);

function isIdleStatus(status: string | null): boolean {
  return status !== null && IDLE_STATUSES.has(status);
}

/** claude ends its turn on Esc. */
const claudeHarness: HarnessAdapter = {
  kind: "claude",
  launchCommand: () => DEFAULT_AGENT_COMMAND,
  interruptSequence: () => "\x1b",
  isIdle: isIdleStatus,
};

/** codex (and most other CLIs) end their turn on Ctrl-C. */
const codexHarness: HarnessAdapter = {
  kind: "codex",
  // Matches the "codex" token expected by getAgentKindForCommand() in
  // src/agent-defaults.ts, so this maps back to agentKind "codex".
  launchCommand: () => "codex",
  interruptSequence: () => "\x03",
  isIdle: isIdleStatus,
};

/**
 * Resolve the harness adapter for a live agent's `agentKind`, for interrupting
 * a running pane before steering it with a new prompt. Mirrors
 * `interruptSequenceFor` in `electron/harness-interrupt.ts` — that file can't
 * be imported here (electron/src sit in separate tsconfigs), so the mapping
 * has to be kept in step by hand. Anything other than "claude" ends its turn
 * on Ctrl-C, matching that function's `default`.
 */
export function adapterForKind(kind: string): HarnessAdapter {
  switch (kind) {
    case "claude":
      return claudeHarness;
    case "codex":
    case "opencode":
    default:
      return codexHarness;
  }
}
