/**
 * Agent detector — tracks foreground process to detect when an agent CLI
 * starts and exits. Status transitions (running/waiting) are handled by
 * hook events from the agent CLI, not by this detector.
 *
 * This detector is responsible for:
 * - Detecting when an agent process appears → track it (stay idle until hooks fire)
 * - Detecting when an agent process exits → transition to "complete" → "idle"
 */

import type { AgentKind, AgentState, AgentStatus } from "./types";

const KNOWN_AGENTS: Record<string, AgentKind> = {
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
};

const COMPLETE_CLEAR_MS = 3000;

export class AgentDetector {
  private kind: AgentKind | null = null;
  private status: AgentStatus = "idle";
  private processName: string | null = null;
  private since: number = Date.now();
  private completeClearTimer: ReturnType<typeof setTimeout> | null = null;
  private _onStatusChange: ((state: AgentState) => void) | null = null;

  set onStatusChange(cb: (state: AgentState) => void) {
    this._onStatusChange = cb;
  }

  getState(): AgentState {
    return {
      kind: this.kind,
      status: this.status,
      processName: this.processName,
      since: this.since,
    };
  }

  /** Called when foreground process info changes (from polling) */
  updateForegroundProcess(name: string | null): void {
    const prevKind = this.kind;
    const prevStatus = this.status;

    if (!name) {
      // Shell is foreground — agent is gone
      if (prevKind && (prevStatus === "thinking" || prevStatus === "working" || prevStatus === "requires_input")) {
        this.transitionToComplete();
      } else if (prevStatus === "complete") {
        // Stop hook already set complete — just start the idle timer
        this.scheduleIdleAfterComplete();
      } else if (prevStatus !== "error") {
        this.transitionToIdle();
      }
      return;
    }

    // Check if it's a known agent binary
    const basename = name.split("/").pop()?.toLowerCase() ?? "";
    const agentKind = KNOWN_AGENTS[basename] ?? null;

    if (agentKind) {
      this.kind = agentKind;
      this.processName = name;

      if (prevKind !== agentKind) {
        this.clearTimers();
        // Just track the agent — stay idle (no dot) until a hook event
        // tells us the agent is actually thinking or responding.
        if (prevStatus !== "idle") {
          this.transition("idle");
        }
      }
    } else if (
      this.kind &&
      (this.status === "thinking" || this.status === "working" || this.status === "requires_input")
    ) {
      // Agent was running but now a different process is foreground
      // (e.g. agent spawned a child) — keep tracking
    } else {
      this.transitionToIdle();
    }
  }

  /** Called by hook events to update status directly */
  setStatus(status: AgentStatus): void {
    if (this.status === "idle" && status !== "idle" && !this.kind) {
      // Agent hook fired but process detection hasn't caught up yet — set kind
      // This shouldn't normally happen, but be defensive.
      return;
    }
    this.transition(status);
  }

  /** Called when terminal output is received — no-op, hooks handle status */
  processOutput(_data: string): void {
    // Kept for API compatibility; hook events drive status transitions now.
  }

  /** Update alt screen state (from mode tracking) */
  setAltScreen(_enabled: boolean): void {
    // Kept for API compatibility
  }

  dispose(): void {
    this.clearTimers();
  }

  private transitionToComplete(): void {
    this.clearTimers();
    this.transition("complete");
    this.scheduleIdleAfterComplete();
  }

  /** Start the timer to transition from complete → idle */
  private scheduleIdleAfterComplete(): void {
    if (this.completeClearTimer) return; // already scheduled
    this.completeClearTimer = setTimeout(() => {
      this.completeClearTimer = null;
      this.transitionToIdle();
    }, COMPLETE_CLEAR_MS);
  }

  private transitionToIdle(): void {
    this.clearTimers();
    this.kind = null;
    this.processName = null;
    if (this.status === "idle") return;
    this.transition("idle");
  }

  private transition(newStatus: AgentStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    this.since = Date.now();
    this._onStatusChange?.(this.getState());
  }

  private clearTimers(): void {
    if (this.completeClearTimer) {
      clearTimeout(this.completeClearTimer);
      this.completeClearTimer = null;
    }
  }
}
