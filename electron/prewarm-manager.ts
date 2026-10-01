import { TerminalHostClient } from "./terminal-host/client";
import crypto from "node:crypto";
import { LOCAL_HOST_ID } from "./backend/types";

type PrewarmState = "idle" | "warming" | "ready";

/**
 * Prewarms a shell session in the background so opening a new pane can
 * attach to one already booted. Local only (ADR-178 §3): prewarming a
 * remote cwd would cost a round-trip to the box for a session the user may
 * never open, so a remote cwd never gets a prewarmed session — `warm` is a
 * no-op for it and `consume` never hands one out. The caller names each
 * cwd's host (ADR-183).
 */
export class PrewarmManager {
  private client: TerminalHostClient;
  private state: PrewarmState = "idle";
  private prewarmPaneId: string | null = null;
  private warmingPaneId: string | null = null;
  private currentCwd: string;
  private currentHostId: string = LOCAL_HOST_ID;
  private currentAgentCommand: string | null = null;
  private currentKind: string | null = null;
  private commandInjected = false;
  /**
   * Panes handed out by `consume()` whose `pty.create` has not arrived yet.
   *
   * A prewarmed session already exists when the pane that adopted it is
   * created, so that create looks like a warm reattach — which is exactly
   * when `ptyCreate` does *not* type a pending command (ADR-179 ticket 11).
   * This is how it tells the one create that is really a cold start in
   * disguise from a second viewer attaching to a live pane.
   */
  private readonly adopted = new Set<string>();
  private defaultCols = 80;
  private defaultRows = 24;

  /** `defaultCwd` is on this machine. */
  constructor(client: TerminalHostClient, defaultCwd: string) {
    this.client = client;
    this.currentCwd = defaultCwd;
  }

  /**
   * Start warming a session in the background — for `cwd` on `hostId` when
   * given, else for the current one.
   */
  async warm(
    target?: { cwd: string; hostId: string },
    agentCommand?: string | null,
    kind?: string | null,
  ): Promise<void> {
    if (target) {
      this.currentCwd = target.cwd;
      this.currentHostId = target.hostId;
    }
    if (agentCommand !== undefined) this.currentAgentCommand = agentCommand;
    if (kind !== undefined) this.currentKind = kind;
    if (this.state === "warming") return;
    if (this.currentHostId !== LOCAL_HOST_ID) {
      // Remote cwd — no prewarm. Drop anything already warmed for a
      // previous (local) cwd so it isn't handed out for this one.
      await this.dispose();
      return;
    }

    this.state = "warming";
    this.commandInjected = false;
    const paneId = `pane-${crypto.randomUUID()}`;
    this.warmingPaneId = paneId;

    const spawnEnv: Record<string, string> | undefined = this.currentKind
      ? { MANOR_AGENT_KIND: this.currentKind }
      : undefined;

    try {
      await this.client.createNoSubscribe(
        paneId,
        this.currentCwd,
        this.defaultCols,
        this.defaultRows,
        true,
        spawnEnv,
      );

      // Check if we were disposed while awaiting (e.g. updateCwd race)
      if (this.warmingPaneId !== paneId) {
        // Session was superseded — kill the orphan
        this.client.kill(paneId).catch(() => {});
        return;
      }

      this.prewarmPaneId = paneId;
      this.warmingPaneId = null;
      this.state = "ready";

      // Inject agent command so it's already booting when consumed.
      // Uses a control request — commandInjected is only set after
      // the daemon confirms the write was queued.
      if (this.currentAgentCommand) {
        try {
          await this.client.writeAfterReady(paneId, this.currentAgentCommand + "\n");
          this.commandInjected = true;
        } catch {
          this.commandInjected = false;
        }
      }
    } catch (err) {
      console.error("[PrewarmManager] Failed to warm session:", err);
      this.state = "idle";
      this.prewarmPaneId = null;
      this.warmingPaneId = null;
      this.commandInjected = false;
    }
  }

  /**
   * Consume the prewarmed session for `cwd` on `hostId` (`cwd` already
   * resolved via `resolveSpawnCwd`, matching `updateCwd`'s caller).
   *
   * Returns the pre-generated paneId and whether the agent command was
   * already injected, or null if no session is ready — including when it was
   * warmed for a different cwd. That guards a race: the user switches to a
   * remote workspace and opens a tab before `pty:updatePrewarmCwd` lands, so
   * without this check the remote tab would adopt a shell warmed for the
   * previous (local) cwd. A session is only ever warmed on this machine,
   * so one asked for on another host is never handed out.
   */
  consume(cwd: string, hostId: string): { paneId: string; commandInjected: boolean } | null {
    if (
      this.state !== "ready" ||
      !this.prewarmPaneId ||
      cwd !== this.currentCwd ||
      hostId !== LOCAL_HOST_ID ||
      hostId !== this.currentHostId
    ) {
      return null;
    }

    const paneId = this.prewarmPaneId;
    const commandInjected = this.commandInjected;
    this.adopted.add(paneId);
    this.prewarmPaneId = null;
    this.state = "idle";
    this.commandInjected = false;

    // Replenish in the background
    this.warm().catch(() => {});

    return { paneId, commandInjected };
  }

  /**
   * True for the first `pty.create` of a pane that adopted a prewarmed
   * session, false for every create after it. Claimed, not merely read: the
   * second viewer of that pane must get `false`.
   */
  claimAdopted(paneId: string): boolean {
    return this.adopted.delete(paneId);
  }

  /** Update CWD (and its host), agent command, and/or kind (e.g. on workspace switch) — kill stale, warm fresh */
  async updateCwd(
    cwd: string,
    hostId: string,
    agentCommand?: string | null,
    kind?: string | null,
  ): Promise<void> {
    const cwdChanged = cwd !== this.currentCwd || hostId !== this.currentHostId;
    const cmdChanged = agentCommand !== undefined && agentCommand !== this.currentAgentCommand;
    const kindChanged = kind !== undefined && kind !== this.currentKind;
    if (!cwdChanged && !cmdChanged && !kindChanged && this.state === "ready") return;
    await this.dispose();
    await this.warm({ cwd, hostId }, agentCommand, kind);
  }

  /** Kill the prewarmed session (ready or in-flight) */
  async dispose(): Promise<void> {
    const toKill = this.prewarmPaneId || this.warmingPaneId;
    // Clear warmingPaneId so an in-flight warm() detects it was superseded
    this.warmingPaneId = null;
    this.prewarmPaneId = null;
    this.state = "idle";
    this.commandInjected = false;

    if (toKill) {
      try {
        await this.client.kill(toKill);
      } catch {
        // ignore — daemon may have restarted
      }
    }
  }

  /** Reset state without killing (e.g. after daemon reconnect when session is already gone) */
  reset(): void {
    this.prewarmPaneId = null;
    this.warmingPaneId = null;
    this.state = "idle";
    this.commandInjected = false;
  }

  /** Check if a prewarmed session is available */
  get isReady(): boolean {
    return this.state === "ready" && this.prewarmPaneId !== null;
  }
}
