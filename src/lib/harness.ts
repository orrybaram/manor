import { DEFAULT_AGENT_COMMAND } from "../agent-defaults";

/**
 * Agent-agnostic harness kinds the Home surface (and, later, `send_to_session`)
 * can drive. Mirrors `AgentKind` in `electron/terminal-host/types.ts` at the
 * points that matter for launch/interrupt behavior.
 */
export type HarnessKind = "claude" | "codex" | "custom";

export interface HarnessAdapter {
  kind: HarnessKind;
  /** Full boot command for this CLI. */
  launchCommand(): string;
  /** Raw pty bytes that end the harness's current turn (graceful cancel). */
  interruptSequence(): string;
  /** Prompt-ready detection for steering, given a `lastAgentStatus`. */
  isIdle(status: string | null): boolean;
}

const IDLE_STATUSES = new Set([
  "requires_input",
  "responded",
  "complete",
  "idle",
]);

function isIdleStatus(status: string | null): boolean {
  return status !== null && IDLE_STATUSES.has(status);
}

/** claude ends its turn on Esc. */
export const claudeHarness: HarnessAdapter = {
  kind: "claude",
  launchCommand: () => DEFAULT_AGENT_COMMAND,
  interruptSequence: () => "\x1b",
  isIdle: isIdleStatus,
};

/** codex (and most other CLIs) end their turn on Ctrl-C. */
export const codexHarness: HarnessAdapter = {
  kind: "codex",
  // Matches the "codex" token expected by getAgentKindForCommand() in
  // src/agent-defaults.ts, so this maps back to agentKind "codex".
  launchCommand: () => "codex",
  interruptSequence: () => "\x03",
  isIdle: isIdleStatus,
};

/** Build a harness adapter for a user-supplied custom command/interrupt. */
export function createCustomHarness(
  command: string,
  interrupt: string,
): HarnessAdapter {
  return {
    kind: "custom",
    launchCommand: () => (command.trim() ? command : DEFAULT_AGENT_COMMAND),
    interruptSequence: () => (interrupt ? interrupt : "\x03"),
    isIdle: isIdleStatus,
  };
}

export interface HomeHarnessPreferences {
  homeHarness: HarnessKind;
  homeCustomCommand: string;
  homeCustomInterrupt: string;
}

/** Resolve the configured home harness adapter from preferences. */
export function resolveHomeAdapter(
  prefs: HomeHarnessPreferences,
): HarnessAdapter {
  switch (prefs.homeHarness) {
    case "codex":
      return codexHarness;
    case "custom":
      return createCustomHarness(
        prefs.homeCustomCommand,
        prefs.homeCustomInterrupt,
      );
    case "claude":
    default:
      return claudeHarness;
  }
}
