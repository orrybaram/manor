import { TerminalHostClient } from "./terminal-host/client";
import crypto from "node:crypto";

type PrewarmState = "idle" | "warming" | "ready";

export class PrewarmManager {
  private client: TerminalHostClient;
  private state: PrewarmState = "idle";
  private prewarmPaneId: string | null = null;
  private currentCwd: string;
  private currentAgentCommand: string | null = null;
  private commandInjected = false;
  private defaultCols = 80;
  private defaultRows = 24;

  constructor(client: TerminalHostClient, defaultCwd: string) {
    this.client = client;
    this.currentCwd = defaultCwd;
  }

  /** Start warming a session in the background */
  async warm(cwd?: string, agentCommand?: string | null): Promise<void> {
    if (cwd) this.currentCwd = cwd;
    if (agentCommand !== undefined) this.currentAgentCommand = agentCommand;
    if (this.state === "warming") return;

    this.state = "warming";
    this.commandInjected = false;
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

      // Inject agent command so it's already booting when consumed.
      // writeAfterReady is a control request — we only set commandInjected
      // after the daemon confirms the write was queued.
      if (this.currentAgentCommand) {
        try {
          await this.client.writeAfterReady(paneId, this.currentAgentCommand + "\n");
          this.commandInjected = true;
        } catch {
          // Write failed — fall back to renderer-side injection
          this.commandInjected = false;
        }
      }
    } catch (err) {
      console.error("[PrewarmManager] Failed to warm session:", err);
      this.state = "idle";
      this.prewarmPaneId = null;
      this.commandInjected = false;
    }
  }

  /**
   * Consume the prewarmed session.
   * Returns the pre-generated paneId and whether the agent command was already
   * injected, or null if no session is ready.
   */
  consume(): { paneId: string; commandInjected: boolean } | null {
    if (this.state !== "ready" || !this.prewarmPaneId) {
      return null;
    }

    const paneId = this.prewarmPaneId;
    const commandInjected = this.commandInjected;
    this.prewarmPaneId = null;
    this.state = "idle";
    this.commandInjected = false;

    // Replenish in the background
    this.warm().catch(() => {});

    return { paneId, commandInjected };
  }

  /** Update CWD and/or agent command (e.g. on workspace switch) — kill stale, warm fresh */
  async updateCwd(cwd: string, agentCommand?: string | null): Promise<void> {
    const cwdChanged = cwd !== this.currentCwd;
    const cmdChanged = agentCommand !== undefined && agentCommand !== this.currentAgentCommand;
    if (!cwdChanged && !cmdChanged && this.state === "ready") return;
    await this.dispose();
    await this.warm(cwd, agentCommand);
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
    this.commandInjected = false;
  }

  /** Reset state without killing (e.g. after daemon reconnect when session is already gone) */
  reset(): void {
    this.prewarmPaneId = null;
    this.state = "idle";
    this.commandInjected = false;
  }

  /** Check if a prewarmed session is available */
  get isReady(): boolean {
    return this.state === "ready" && this.prewarmPaneId !== null;
  }
}
