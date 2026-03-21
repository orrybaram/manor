/**
 * Agent detector — tracks foreground process to detect when an agent CLI
 * starts and exits. Status transitions are driven by:
 *
 * 1. Hook events (highest priority) — direct from agent CLI hooks
 * 2. Fallback status — output patterns, title detection (lower priority)
 * 3. Process polling — PID sweep for stale agents (lowest priority)
 *
 * Fallback signals are debounced: they cannot override a hook-driven status
 * within 2 seconds of the last hook event.
 */

import type { AgentKind, AgentState, AgentStatus } from "./types";

const KNOWN_AGENTS: Record<string, AgentKind> = {
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
};

/** Titles that are just the agent binary name — not useful as a task label */
const GENERIC_TITLES = new Set(["claude", "claude code", "opencode", "codex"]);

const KNOWN_SHELLS = new Set(["zsh", "bash", "sh", "fish", "nu", "pwsh", "powershell"]);

const COMPLETE_CLEAR_MS = 3000;
const HOOK_DEBOUNCE_MS = 2000;

export class AgentDetector {
  private kind: AgentKind | null = null;
  private status: AgentStatus = "idle";
  private processName: string | null = null;
  private since: number = Date.now();
  private title: string | null = null;
  private completeClearTimer: ReturnType<typeof setTimeout> | null = null;
  private _onStatusChange: ((state: AgentState) => void) | null = null;

  /** Timestamp of the last hook-driven status update */
  private lastHookTime = 0;

  /** Whether the agent has been active (thinking/working) in this session.
   *  Prevents spurious Stop hooks during startup from showing "complete". */
  private hasBeenActive = false;

  /** Tracked agent PIDs for stale sweep */
  private trackedPids = new Map<number, { kind: AgentKind; status: AgentStatus }>();

  set onStatusChange(cb: (state: AgentState) => void) {
    this._onStatusChange = cb;
  }

  getState(): AgentState {
    return {
      kind: this.kind,
      status: this.status,
      processName: this.processName,
      since: this.since,
      title: this.title,
    };
  }

  /** Update the terminal title (from OSC 0/2 sequences) */
  setTitle(title: string | null): void {
    if (this.title === title) return;
    this.title = title;
    this._onStatusChange?.(this.getState());
  }

  /** Called when foreground process info changes (from polling) */
  updateForegroundProcess(name: string | null, pid?: number): void {
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

      // Track PID if provided
      if (pid !== undefined) {
        this.trackedPids.set(pid, { kind: agentKind, status: this.status });
      }

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
      (this.status === "thinking" || this.status === "working" || this.status === "requires_input") &&
      !KNOWN_SHELLS.has(basename)
    ) {
      // Agent was running but now a different process is foreground
      // (e.g. agent spawned a child) — keep tracking
    } else if (
      this.kind &&
      (this.status === "thinking" || this.status === "working" || this.status === "requires_input")
    ) {
      // Shell returned to foreground — agent exited
      this.transitionToComplete();
    } else {
      this.transitionToIdle();
    }
  }

  /** Called by hook events to update status directly (highest priority) */
  setStatus(status: AgentStatus, kind?: AgentKind): void {
    // If kind is provided and we don't have one yet, set it.
    // Hook events know which agent they came from (e.g. "claude").
    if (kind && !this.kind) {
      this.kind = kind;
      this.processName = kind; // best we know without process detection
    }

    if (this.status === "idle" && status !== "idle" && !this.kind) {
      // Agent hook fired but process detection hasn't caught up yet
      // and no kind was provided — can't track without knowing the agent.
      return;
    }

    // Track when the agent first becomes active
    if (status === "thinking" || status === "working" || status === "requires_input") {
      this.hasBeenActive = true;
    }

    // Ignore complete/error if the agent was never active in this session.
    // This prevents spurious Stop hooks during CLI startup from showing "complete".
    if ((status === "complete" || status === "error") && !this.hasBeenActive) {
      return;
    }

    this.lastHookTime = Date.now();

    if (status === "complete") {
      this.transitionToComplete();
    } else {
      this.transition(status);
    }

    // Update tracked PID statuses
    for (const [pid, info] of this.trackedPids) {
      info.status = status;
    }
  }

  /**
   * Called by fallback detection (output patterns, title) — lower priority than hooks.
   * Won't override a hook-driven status within HOOK_DEBOUNCE_MS of the last hook event.
   */
  setFallbackStatus(status: AgentStatus): void {
    // Don't apply fallback if no agent is being tracked
    if (!this.kind) return;

    // Don't override a recent hook-driven status
    const elapsed = Date.now() - this.lastHookTime;
    if (elapsed < HOOK_DEBOUNCE_MS) return;

    // Don't transition to the same status
    if (this.status === status) return;

    if (status === "complete") {
      this.transitionToComplete();
    } else {
      this.transition(status);
    }
  }

  /**
   * Sweep tracked PIDs for stale (dead) processes.
   * For each tracked agent with a non-idle status, check if the process still exists.
   * Dead processes get forced to idle.
   */
  sweepStalePids(): void {
    const deadPids: number[] = [];

    for (const [pid, info] of this.trackedPids) {
      if (info.status === "idle") continue;

      try {
        process.kill(pid, 0); // Just checks existence, sends no signal
        // Process is alive — no action needed
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          // Process does not exist — it's dead
          deadPids.push(pid);
        }
        // EPERM means it exists but we can't signal it — keep tracking
      }
    }

    for (const pid of deadPids) {
      this.trackedPids.delete(pid);
    }

    // If all tracked PIDs are dead and agent was not idle, force to idle
    if (deadPids.length > 0 && this.trackedPids.size === 0 && this.status !== "idle") {
      this.transitionToIdle();
    }
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
    this.trackedPids.clear();
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
    this.title = null;
    this.hasBeenActive = false;
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
