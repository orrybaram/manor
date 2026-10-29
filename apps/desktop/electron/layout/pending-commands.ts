/**
 * Commands waiting for a pane that does not have a shell yet.
 *
 * "Open a tab and run `pnpm dev` in it" is two things happening in two places:
 * a structural change, which the `LayoutStore` owns, and a line of text typed
 * into a shell that will not exist until some renderer mounts the pane the
 * change created. The text has to wait somewhere in between.
 *
 * It used to wait in the *sending renderer's* store, which is why a route
 * could not carry it: `POST /tabs { command }` and `POST /panes/split
 * { command }` mint a pane on the server, and a server has no renderer whose
 * map to seed. This is that map, on the server, where every producer can
 * reach it — the structural routes, `POST /agents`, and the desktop through
 * `layout.setPendingCommand`.
 *
 * The consumer is `spawnPane` (`electron/server/spawn-pane.ts`): the moment a
 * *fresh* session exists for the pane, it takes the entry and writes it.
 * `take` is destructive, so a second viewer's `pty.create` for the same pane
 * finds nothing and nobody's command is typed twice.
 *
 * Most entries wait for a renderer to mount their pane. A launch does not:
 * an agent's startup line or a new workspace's setup script
 * starts its session on the server as soon as its pane is in a tree
 * (`launchesOnApply`), so a host with no viewer still runs it.
 *
 * Not persisted, deliberately: a command that outlives the process would run
 * in a shell the user opened days later, having forgotten they asked for it.
 */

/**
 * What kind of line this is — a shell command, an agent launch, or a new
 * workspace's setup script (`script; exit`, queued by the server only).
 */
export type PendingCommandKind = "shell" | "agent-startup" | "setup-script";

export interface PendingCommand {
  text: string;
  kind: PendingCommandKind;
  /**
   * Send it with Enter. Without, the text is only typed, for the user to
   * review and run — a health-check fix-it command ("fix in terminal").
   * One queue for both.
   */
  submit: boolean;
  /**
   * An agent's first prompt, raw and unflattened, kept apart from `text`
   * (the bare harness command). `pty.create` writes it to a file
   * on the pane's host and types a short line that reads it, because a long
   * line typed into a fresh shell is cut at the tty's canonical line limit.
   */
  prompt?: string;
  /**
   * The agent kind the line starts, when its producer knows it (the Agents
   * modal resuming a Session): the session's `MANOR_AGENT_KIND`, rather
   * than one guessed from the line or the workspace's project.
   */
  agentKind?: string;
  /**
   * Taken once already and never delivered: its remote host dropped before
   * the shell was ready. The next `pty.create` for the pane
   * types it even on a reattach, since the session it was meant for may have
   * survived on the host.
   */
  requeued?: boolean;
}

export interface PendingCommandOptions {
  /** Defaults to true: run the command. */
  submit?: boolean;
  /** An agent launch's prompt, delivered through a file. */
  prompt?: string;
  /** The agent kind the line starts (`PendingCommand.agentKind`). */
  agentKind?: string;
}

export class PendingCommands {
  private readonly byPane = new Map<string, PendingCommand>();

  /**
   * Queue `text` for `paneId`, replacing anything already queued for it.
   *
   * Producers set *before* they send the structural command that creates the
   * pane: the layout broadcast is what makes a renderer mount it, and a mount
   * that reaches `pty.create` before the entry lands would find nothing.
   */
  set(
    paneId: string,
    text: string,
    kind: PendingCommandKind = "shell",
    opts?: PendingCommandOptions,
  ): void {
    const entry: PendingCommand = { text, kind, submit: opts?.submit ?? true };
    if (opts?.prompt !== undefined) entry.prompt = opts.prompt;
    if (opts?.agentKind !== undefined) entry.agentKind = opts.agentKind;
    this.byPane.set(paneId, entry);
  }

  /** Hand the pane's command over — once. */
  take(paneId: string): PendingCommand | null {
    const entry = this.byPane.get(paneId);
    if (!entry) return null;
    this.byPane.delete(paneId);
    return entry;
  }

  /**
   * Put back a command `take` handed out that never reached the shell, for
   * the pane's next `pty.create`. Never over a command queued since — that
   * one is newer, and what the pane is now waiting for.
   */
  requeue(paneId: string, entry: PendingCommand): void {
    if (this.byPane.has(paneId)) return;
    this.byPane.set(paneId, { ...entry, requeued: true });
  }

  /**
   * Whether the pane's queued command starts its session the moment its pane
   * joins a tree, rather than when a renderer mounts it: an
   * agent launch or a setup script. A plain shell line still waits for a
   * viewer, who is the one that asked to watch it run.
   */
  launchesOnApply(paneId: string): boolean {
    const kind = this.byPane.get(paneId)?.kind;
    return kind === "agent-startup" || kind === "setup-script";
  }

  /** The pane's queued command, left in place. */
  peek(paneId: string): PendingCommand | null {
    return this.byPane.get(paneId) ?? null;
  }

  /** Whether the pane's queued command is one `requeue` put back. */
  isRequeued(paneId: string): boolean {
    return this.byPane.get(paneId)?.requeued === true;
  }

  /** Forget a pane's command: its structural change was refused, or its pane
   *  left the tree before anything ever mounted it. */
  clear(paneId: string): void {
    this.byPane.delete(paneId);
  }

  /** How many panes are still waiting. For tests and diagnostics. */
  get size(): number {
    return this.byPane.size;
  }
}
