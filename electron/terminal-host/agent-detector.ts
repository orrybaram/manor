/**
 * Agent detector — state machine that combines foreground process info
 * and output timing to determine agent status for a terminal pane.
 */

import type { AgentKind, AgentState, AgentStatus } from "./types";

const KNOWN_AGENTS: Record<string, AgentKind> = {
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
};

const WAITING_TIMEOUT_MS = 2000;
const COMPLETE_CLEAR_MS = 3000;

export class AgentDetector {
  private kind: AgentKind | null = null;
  private status: AgentStatus = "idle";
  private processName: string | null = null;
  private since: number = Date.now();
  private lastOutputTime = 0;
  private waitingCheckTimer: ReturnType<typeof setInterval> | null = null;
  private completeClearTimer: ReturnType<typeof setTimeout> | null = null;
  private altScreen = false;
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
        // Agent just exited — show "complete" briefly
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
        this.ensureWaitingCheck();
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

  /** Called when terminal output is received */
  processOutput(_data: string): void {
    if (
      this.status === "idle" ||
      this.status === "complete" ||
      this.status === "error"
    )
      return;

    this.lastOutputTime = Date.now();

    if (this.status === "waiting") {
      this.transition("running");
      this.ensureWaitingCheck();
    }
  }

  /** Update alt screen state (from mode tracking) */
  setAltScreen(enabled: boolean): void {
    this.altScreen = enabled;
  }

  dispose(): void {
    this.clearTimers();
  }

  private transitionToComplete(): void {
    this.clearTimers();
    this.transition("complete");

    // Auto-clear to idle after 3s
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

  /** Single interval that checks if output has gone silent → transition to "waiting" */
  private ensureWaitingCheck(): void {
    if (this.waitingCheckTimer) return;
    this.lastOutputTime = Date.now();
    this.waitingCheckTimer = setInterval(() => {
      if (
        this.status === "running" &&
        !this.altScreen &&
        Date.now() - this.lastOutputTime > WAITING_TIMEOUT_MS
      ) {
        this.transition("waiting");
        // Stop checking once we've transitioned — processOutput will restart
        if (this.waitingCheckTimer) {
          clearInterval(this.waitingCheckTimer);
          this.waitingCheckTimer = null;
        }
      }
    }, WAITING_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.waitingCheckTimer) {
      clearInterval(this.waitingCheckTimer);
      this.waitingCheckTimer = null;
    }
    if (this.completeClearTimer) {
      clearTimeout(this.completeClearTimer);
      this.completeClearTimer = null;
    }
  }
}
