import { TerminalHostClient } from "./terminal-host/client";
import crypto from "node:crypto";

type PrewarmState = "idle" | "warming" | "ready";

export class PrewarmManager {
  private client: TerminalHostClient;
  private state: PrewarmState = "idle";
  private prewarmPaneId: string | null = null;
  private currentCwd: string;
  private defaultCols = 80;
  private defaultRows = 24;

  constructor(client: TerminalHostClient, defaultCwd: string) {
    this.client = client;
    this.currentCwd = defaultCwd;
  }

  /** Start warming a session in the background */
  async warm(cwd?: string): Promise<void> {
    if (cwd) this.currentCwd = cwd;
    if (this.state === "warming") return;

    this.state = "warming";
    const paneId = `pane-${crypto.randomUUID()}`;

    try {
      await this.client.createNoSubscribe(
        paneId,
        this.currentCwd,
        this.defaultCols,
        this.defaultRows,
        true, // prewarmed flag
      );
      this.prewarmPaneId = paneId;
      this.state = "ready";
    } catch (err) {
      console.error("[PrewarmManager] Failed to warm session:", err);
      this.state = "idle";
      this.prewarmPaneId = null;
    }
  }

  /**
   * Consume the prewarmed session.
   * Returns the pre-generated paneId, or null if no session is ready.
   */
  consume(): string | null {
    if (this.state !== "ready" || !this.prewarmPaneId) {
      return null;
    }

    const paneId = this.prewarmPaneId;
    this.prewarmPaneId = null;
    this.state = "idle";

    // Replenish in the background
    this.warm().catch(() => {});

    return paneId;
  }

  /** Update CWD (e.g. on workspace switch) — kill stale, warm fresh */
  async updateCwd(cwd: string): Promise<void> {
    if (cwd === this.currentCwd && this.state === "ready") return;
    await this.dispose();
    await this.warm(cwd);
  }

  /** Kill the prewarmed session */
  async dispose(): Promise<void> {
    if (this.prewarmPaneId) {
      try {
        await this.client.kill(this.prewarmPaneId);
      } catch {
        // ignore — daemon may have restarted
      }
    }
    this.prewarmPaneId = null;
    this.state = "idle";
  }

  /** Reset state without killing (e.g. after daemon reconnect when session is already gone) */
  reset(): void {
    this.prewarmPaneId = null;
    this.state = "idle";
  }

  /** Check if a prewarmed session is available */
  get isReady(): boolean {
    return this.state === "ready" && this.prewarmPaneId !== null;
  }
}
