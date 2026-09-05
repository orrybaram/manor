import type { AgentStatus } from "../electron.d";

export type WorkspaceIndicatorKind =
  | "thinking"
  | "working"
  | "needs_you"
  | "done_unread";
export type WorkspaceIndicator = { kind: WorkspaceIndicatorKind; pulse: boolean } | null;

/**
 * ADR-167: the sidebar agent dot answers exactly one question — "does this
 * workspace need me?" — collapsing the 7 `AgentStatus` values into 4 visible
 * states plus quiet (`null`). `pulse` means exactly one thing everywhere it
 * appears: unread. It is the unseen flag computed by the status hooks
 * (`requires_input` unseen, or `responded` unseen), passed through unchanged
 * so a caller can tell "needs you and you haven't looked yet" apart from
 * "needs you, already seen" without a second signal.
 */
export function toWorkspaceIndicator(
  status: AgentStatus | null | undefined,
  pulse: boolean,
): WorkspaceIndicator {
  switch (status) {
    case "thinking":
      return { kind: "thinking", pulse: false };
    case "working":
      return { kind: "working", pulse: false };
    case "requires_input":
      return { kind: "needs_you", pulse };
    case "error":
      return { kind: "needs_you", pulse: false };
    case "responded":
      return pulse ? { kind: "done_unread", pulse: true } : null;
    case "complete":
    case "idle":
    case null:
    case undefined:
    default:
      return null;
  }
}
