/**
 * useTerminalStream — subscribes to PTY output, exit, and CWD events.
 *
 * Owns the whole PTY-bytes-to-xterm path, including its opening move: nothing
 * reaches the terminal until `openRestored()` puts it in sync with the daemon.
 *
 * That opening move is one operation, so it lives in one place. The daemon
 * subscribes us to the session's stream before the create/attach reply gets
 * back here — deliberately, so nothing is lost in the gap — which means some of
 * the output we queued is also inside the warm-restore snapshot. `openRestored`
 * writes the snapshot and then only the queued chunks it does not already
 * cover; see `outputAfterSnapshot`.
 *
 * **Subscribe first, create second, on every platform.** These subscriptions
 * are bridge frames now, on both transports: the effect
 * below runs before `useTerminalLifecycle`'s create effect — hooks run in the
 * order they are called, and this one is called first — so the host has this
 * viewer on the pane's subscriber list before `pty.create` reaches the table.
 * Reversing those two would lose the opening bytes of a fresh shell, which no
 * snapshot can put back: the session is new, so there is nothing to snapshot.
 *
 * Kitty keyboard negotiation is not handled here but in the terminal's own
 * parser (`installKittyKeyboard`), which sees sequences split across chunks.
 *
 * **A pane off screen holds its output** (`lib/held-output.ts`): while it is
 * not `shown`, or the whole window is hidden, chunks are held instead of
 * written, and the pane catches up on show, on `catchUp()` (focus, input),
 * or at once when a held chunk asks a terminal query, so the reply goes out
 * when it always did. A title in held output is applied without catching
 * up. Past the hold limit the pane catches up from the host's snapshot
 * (`pty.attach`) instead of replaying.
 */

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { Terminal } from "@xterm/xterm";
import type { PtyAttachResult } from "../electron.d";
import { useAppStore } from "../store/app-store";
import { useMountEffect } from "./useMountEffect";
import { resizeInStream } from "../lib/terminal-resize-stream";
import {
  outputAfterSnapshot,
  type TerminalRestore,
} from "../lib/snapshot-dedupe";
import { HeldOutput, holdingEnabled, type HeldItem } from "../lib/held-output";

/** A queued resize, or a queued chunk of output, in arrival order. */
type QueuedItem = HeldItem;

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

/** Whether the window's page is visible (not minimized or hidden). */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

export interface TerminalStreamOptions {
  /** Whether the pane is on screen; off screen it holds its output. */
  shown?: boolean;
  /**
   * Re-attach to the session for its snapshot: how an overflowed hold
   * catches up. Without it the pane never holds.
   */
  attach?: () => Promise<PtyAttachResult>;
}

export function useTerminalStream(
  paneId: string,
  term: Terminal | null,
  onError?: (message: string) => void,
  resettingRef?: React.RefObject<boolean>,
  { shown = true, attach }: TerminalStreamOptions = {},
) {
  const termRef = useRef(term);
  termRef.current = term;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  /**
   * What arrived before the terminal was taking writes, in order, or null once
   * it is. A resize sits in here alongside the output because its position
   * among the chunks is what it means.
   */
  const queuedRef = useRef<QueuedItem[] | null>([]);
  /** What the pane holds while off screen, or null while it writes as output arrives. */
  const heldRef = useRef<HeldOutput | null>(null);
  const attachRef = useRef(attach);
  attachRef.current = attach;
  /**
   * Bring `target` up to the session's current state and let output flow: write
   * the warm-restore snapshot, then the queued chunks it does not already
   * account for.
   *
   * Takes the terminal explicitly so the caller doesn't have to assume React
   * has re-rendered with it by the time the create/attach round trip lands. A
   * cold session passes no snapshot, which writes the queue as-is.
   */
  const openRestored = useCallback(
    (target: Terminal, snapshot?: TerminalRestore | null) => {
      const items = queuedRef.current ?? [];
      queuedRef.current = null;
      if (snapshot?.ansi) target.write(snapshot.ansi);
      // The snapshot was serialized at the session's current size, so anything
      // it covers is already at that size; only the chunks after it, and the
      // resizes among them, still have to be replayed in order.
      const covered = new Set(
        outputAfterSnapshot(
          items.flatMap((i) => (i.kind === "data" ? [i.chunk] : [])),
          snapshot?.seq,
        ),
      );
      for (const item of items) {
        if (item.kind === "resize") resizeInStream(target, item.cols, item.rows);
        else if (covered.has(item.chunk)) target.write(item.chunk.data);
      }
    },
    [],
  );

  /** Queue output again, so the next mount's attach gets the same ordering guarantee. */
  const closeOutput = useCallback(() => {
    queuedRef.current = [];
    // That attach's snapshot covers whatever was held.
    heldRef.current?.take();
  }, []);

  /** Write held items in order: into the attach queue while one is open (a restore under way), else the terminal. */
  const writeHeld = useCallback((target: Terminal, items: readonly HeldItem[]) => {
    for (const item of items) {
      if (queuedRef.current) queuedRef.current.push(item);
      else if (item.kind === "resize") resizeInStream(target, item.cols, item.rows);
      else target.write(item.chunk.data);
    }
  }, []);

  /**
   * Restore the screen from the host's snapshot: what a hold that outgrew
   * its limit catches up with. Output queues meanwhile, and `openRestored`
   * writes the part of it the snapshot doesn't cover, as on every attach.
   * The old screen stays up until the snapshot lands.
   */
  const restoreFromHost = useCallback(
    (target: Terminal) => {
      // Already queuing: an attach is under way, and its snapshot is newer.
      const reattach = attachRef.current;
      if (queuedRef.current || !reattach) return;
      queuedRef.current = [];
      reattach().then(
        (result) => {
          if (termRef.current !== target) return;
          if (!result.ok) {
            // The session is gone or away: let what queued through, and the
            // pane's own exit and recovery paths take it from there.
            openRestored(target);
            return;
          }
          if (result.winsizeOwner === false && result.cols && result.rows) {
            target.resize(result.cols, result.rows);
          }
          target.reset();
          openRestored(target, result.snapshot ? { ansi: result.snapshot, seq: result.snapshotSeq } : null);
        },
        () => {
          if (termRef.current === target) openRestored(target);
        },
      );
    },
    [openRestored],
  );

  /**
   * Write everything held, in order, and go on holding if still off screen.
   * Called on show, focus, input, and when held output asks a query.
   */
  const catchUp = useCallback(() => {
    const held = heldRef.current;
    const target = termRef.current;
    if (!held || !target) return;
    const next = held.take();
    if (next.kind === "restore") {
      restoreFromHost(target);
      return;
    }
    writeHeld(target, next.items);
  }, [restoreFromHost, writeHeld]);

  /**
   * The pane's session ended: let whatever output it queued through, and
   * close the pane — unless it is being reset, whose old session's exit is
   * expected and whose terminal stays. Also what a resync's attach does when
   * it finds the session gone, having missed this exit while its connection
   * was down.
   */
  const sessionEnded = useCallback(
    (target: Terminal | null = termRef.current) => {
      // What it held goes out first, as it would have; an overflowed hold has
      // nothing left to write and its pane is closing.
      const held = heldRef.current?.take();
      if (target && held?.kind === "write") writeHeld(target, held.items);
      if (target) openRestored(target);
      if (resettingRef?.current) return;
      useAppStore.getState().closePaneById(paneId);
    },
    [paneId, resettingRef, openRestored, writeHeld],
  );

  useMountEffect(() => {
    const unsubOutput = window.electronAPI.pty.onOutput(
      paneId,
      (data: string, seq?: number) => {
        if (queuedRef.current) {
          queuedRef.current.push({ kind: "data", chunk: { data, seq } });
          return;
        }
        const held = heldRef.current;
        if (!held) {
          termRef.current?.write(data);
          return;
        }
        const { query, title } = held.push({ data, seq });
        if (title !== null) useAppStore.getState().setPaneTitleFromStream(paneId, title);
        if (query) catchUp();
      },
    );

    // This is also how a *follower* learns the winsize owner moved the grid:
    // the same event, applied to the emulator the same way. The
    // grid change it causes reaches `useFollowerFit`'s `term.onResize`, which
    // re-fits the font instead of measuring the pane and sending the size
    // back — sending it back would be a loop with a pty in it, and the pty is
    // the desktop's.
    const unsubResized = window.electronAPI.pty.onResized(
      paneId,
      (cols: number, rows: number) => {
        const t = termRef.current;
        if (queuedRef.current) queuedRef.current.push({ kind: "resize", cols, rows });
        else if (heldRef.current) heldRef.current.pushResize(cols, rows);
        else if (t) resizeInStream(t, cols, rows);
      },
    );

    const unsubExit = window.electronAPI.pty.onExit(paneId, () => sessionEnded());

    const unsubCwd = window.electronAPI.pty.onCwd(paneId, (cwdPath: string) => {
      useAppStore.getState().setPaneCwd(paneId, cwdPath);
    });

    const unsubError = window.electronAPI.pty.onError(
      paneId,
      (message: string) => {
        onErrorRef.current?.(message);
      },
    );

    return () => {
      unsubOutput();
      unsubResized();
      unsubExit();
      unsubCwd();
      unsubError();
    };
  });

  // Hold while off screen; catch up before the frame that shows the pane.
  const visible = useDocumentVisible();
  const holding = (!shown || !visible) && attach !== undefined && holdingEnabled();
  useLayoutEffect(() => {
    if (holding) {
      heldRef.current ??= new HeldOutput();
      return;
    }
    catchUp();
    heldRef.current = null;
  }, [holding, catchUp]);

  /** How much the pane holds right now; null while it isn't holding. */
  const heldSize = useCallback(() => heldRef.current?.size ?? null, []);

  return { openRestored, closeOutput, sessionEnded, catchUp, heldSize };
}
