/**
 * PrewarmManager — keeps one hidden, pre-warmed daemon session ready so that
 * starting a new task is instant rather than waiting for PTY spawn + shell init.
 */

import { randomUUID } from "node:crypto";
import type { TerminalHostClient } from "./terminal-host/client";
import type { SessionInfo, TerminalSnapshot } from "./terminal-host/types";

type PrewarmState = "idle" | "warming" | "ready";

export class PrewarmManager {
  private prewarmSessionId: string | null = null;
  private state: PrewarmState = "idle";
  private client: TerminalHostClient;
  private currentCwd: string;

  constructor(client: TerminalHostClient, defaultCwd: string) {
    this.client = client;
    this.currentCwd = defaultCwd;
  }

  /** Start warming a session for the given CWD */
  async warm(cwd: string): Promise<void> {
    this.currentCwd = cwd;
    this.state = "warming";

    const sessionId = `prewarm-${randomUUID()}`;
    this.prewarmSessionId = sessionId;

    try {
      await this.client.prewarm(sessionId, cwd, 220, 50);
      // Only mark ready if this is still the session we care about
      // (updateCwd may have replaced it while we were awaiting)
      if (this.prewarmSessionId === sessionId) {
        this.state = "ready";
      }
    } catch (err) {
      console.error("[prewarm] Failed to prewarm session:", err);
      if (this.prewarmSessionId === sessionId) {
        this.state = "idle";
        this.prewarmSessionId = null;
      }
    }
  }

  /**
   * Try to consume the prewarmed session.
   * Returns null if the prewarmed session is not ready yet (caller should fall
   * back to the normal createOrAttach path).
   */
  async consume(
    newSessionId: string,
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null } | null> {
    if (this.state !== "ready" || !this.prewarmSessionId) {
      return null;
    }

    const oldSessionId = this.prewarmSessionId;

    // Mark as consumed immediately so concurrent calls don't double-claim
    this.state = "idle";
    this.prewarmSessionId = null;

    try {
      const result = await this.client.claimPrewarmed(
        oldSessionId,
        newSessionId,
        cwd,
        cols,
        rows,
      );

      // Start warming the next session in the background (do not await)
      this.warm(this.currentCwd).catch((err) => {
        console.error("[prewarm] Background warm after consume failed:", err);
      });

      return { session: result.session, snapshot: result.snapshot };
    } catch (err) {
      console.error("[prewarm] Failed to claim prewarmed session:", err);
      // Start warming a fresh one anyway
      this.warm(this.currentCwd).catch((err2) => {
        console.error("[prewarm] Background warm after failed claim:", err2);
      });
      return null;
    }
  }

  /**
   * Update the target CWD (e.g. on workspace switch).
   * If the CWD changes, the stale prewarmed session is killed and a new one is
   * warmed for the new CWD.
   */
  async updateCwd(cwd: string): Promise<void> {
    if (cwd === this.currentCwd) return;

    // Kill the stale session if one exists
    const staleId = this.prewarmSessionId;
    this.prewarmSessionId = null;
    this.state = "idle";

    if (staleId) {
      try {
        await this.client.kill(staleId);
      } catch {
        // Session may already be gone — ignore
      }
    }

    // Warm a new session for the new CWD
    await this.warm(cwd);
  }

  /** Kill the prewarmed session (workspace changed, app quitting) */
  async dispose(): Promise<void> {
    const sessionId = this.prewarmSessionId;
    this.prewarmSessionId = null;
    this.state = "idle";

    if (sessionId) {
      try {
        await this.client.kill(sessionId);
      } catch {
        // Session may already be gone — ignore
      }
    }
  }
}
