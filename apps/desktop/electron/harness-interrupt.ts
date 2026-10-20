/**
 * Main-side interrupt-key map, keyed by `agentKind`. Standalone module (no
 * `src/` import) so it respects the electron tsconfig boundary. Used by
 * `send_to_session`'s pty write to gracefully end a harness's current turn
 * before injecting a new prompt.
 */
export function interruptSequenceFor(agentKind: string, custom?: string): string {
  switch (agentKind) {
    case "claude":
      return "\x1b";
    case "codex":
    case "opencode":
    case "pi":
      return "\x03";
    case "custom":
      return custom && custom.length > 0 ? custom : "\x03";
    default:
      return "\x03";
  }
}
