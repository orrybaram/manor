/**
 * Agent detector — tracks foreground process to detect when an agent CLI
 * starts and exits. Status transitions (running/waiting) are handled by
 * hook events from the agent CLI, not by this detector.
 *
 * This detector is responsible for:
 * - Detecting when an agent process appears → transition to "running"
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
      if (prevKind && (prevStatus === "running" || prevStatus === "waiting")) {
        this.transitionToComplete();
      } else if (prevStatus !== "complete" && prevStatus !== "error") {
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

      if (
        prevStatus === "idle" ||
        prevStatus === "complete" ||
        prevKind !== agentKind
      ) {
        this.clearTimers();
        this.transition("running");
      }
    } else if (
      this.kind &&
      (this.status === "running" || this.status === "waiting")
    ) {
      // Agent was running but now a different process is foreground
      // (e.g. agent spawned a child) — keep tracking
    } else {
      this.transitionToIdle();
    }
  }

  /** Called by hook events to update status directly */
  setStatus(status: AgentStatus): void {
    if (this.status === "idle" && status !== "idle") {
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

    this.completeClearTimer = setTimeout(() => {
      this.completeClearTimer = null;
      this.transitionToIdle();
    }, COMPLETE_CLEAR_MS);
  }

  private transitionToIdle(): void {
    if (this.status === "idle") return;
    this.clearTimers();
    this.kind = null;
    this.processName = null;
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
