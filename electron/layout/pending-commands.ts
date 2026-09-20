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
  set(paneId: string, text: string, kind: PendingCommandKind = "shell"): void {
    this.byPane.set(paneId, { text, kind });
  }

  /** Hand the pane's command over — once. */
  take(paneId: string): PendingCommand | null {
    const entry = this.byPane.get(paneId);
    if (!entry) return null;
    this.byPane.delete(paneId);
    return entry;
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
