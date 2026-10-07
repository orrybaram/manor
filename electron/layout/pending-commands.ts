/**
 * Commands waiting for a pane that does not have a shell yet (ADR-179 ticket
 * 11).
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
 * The consumer is `ptyCreate` (`electron/ipc/pty.ts`): the moment a *fresh*
 * session exists for the pane, it takes the entry and writes it. `take` is
 * destructive, so a second viewer's `pty.create` for the same pane finds
 * nothing and nobody's command is typed twice.
 *
 * Not persisted, deliberately: a command that outlives the process would run
 * in a shell the user opened days later, having forgotten they asked for it.
 */

/** What kind of line this is — a shell command, or an agent launch. */
export type PendingCommandKind = "shell" | "agent-startup";

export interface PendingCommand {
  text: string;
  kind: PendingCommandKind;
  /**
   * Send it with Enter. Without, the text is only typed, for the user to
   * review and run — a health-check fix-it command (ADR-178 ticket 5's "fix
   * in terminal"). One queue for both (ADR-183).
   */
  submit: boolean;
  /**
   * An agent's first prompt, raw and unflattened, kept apart from `text`
   * (the bare harness command) (ADR-209). `pty.create` writes it to a file
   * on the pane's host and types a short line that reads it, because a long
   * line typed into a fresh shell is cut at the tty's canonical line limit.
   */
  prompt?: string;
  /**
   * Taken once already and never delivered: its remote host dropped before
   * the shell was ready (ADR-178 §6). The next `pty.create` for the pane
   * types it even on a reattach, since the session it was meant for may have
   * survived on the host.
   */
  requeued?: boolean;
}

export interface PendingCommandOptions {
  /** Defaults to true: run the command. */
  submit?: boolean;
  /** An agent launch's prompt, delivered through a file (ADR-209). */
  prompt?: string;
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
