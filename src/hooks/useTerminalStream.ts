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
 * are bridge frames now (ADR-180 ticket 5), on both transports: the effect
 * below runs before `useTerminalLifecycle`'s create effect — hooks run in the
 * order they are called, and this one is called first — so the host has this
 * viewer on the pane's subscriber list before `pty.create` reaches the table.
 * Reversing those two would lose the opening bytes of a fresh shell, which no
 * snapshot can put back: the session is new, so there is nothing to snapshot.
 *
 * Kitty keyboard negotiation is not handled here but in the terminal's own
 * parser (`installKittyKeyboard`), which sees sequences split across chunks.
 */

import { useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "../store/app-store";
import { useMountEffect } from "./useMountEffect";
import { resizeInStream } from "../lib/terminal-resize-stream";
import {
  outputAfterSnapshot,
  type QueuedOutput,
  type TerminalRestore,
} from "../lib/snapshot-dedupe";

/** A queued resize, or a queued chunk of output, in arrival order. */
type QueuedItem =
  | { kind: "data"; chunk: QueuedOutput }
  | { kind: "resize"; cols: number; rows: number };

export function useTerminalStream(
  paneId: string,
  term: Terminal | null,
  onError?: (message: string) => void,
  resettingRef?: React.RefObject<boolean>,
) {
  const termRef = useRef(term);
  termRef.current = term;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  /**
   * What arrived before the terminal was taking writes, in order, or null once
   * it is. A resize sits in here alongside the output because its position
   * among the chunks is what it means — see ADR-164.
   */
  const queuedRef = useRef<QueuedItem[] | null>([]);
  /**
   * Bring `target` up to the session's current state and let output flow: write
   * the warm-restore snapshot, then the queued chunks it does not already
   * account for.
   *
   * Takes the terminal explicitly so the caller doesn't have to assume React
   * has re-rendered with it by the time the create/attach round trip lands. A
   * cold session passes no snapshot, which writes the queue as-is.
   *
   * `replace` is for a re-attach into a terminal that already shows the
   * session (a bridge resync, ADR-220 D3): the buffer is reset first, so the
   * snapshot replaces the old screen rather than repeating it below.
   */
  const openRestored = useCallback(
    (
      target: Terminal,
      snapshot?: TerminalRestore | null,
      { replace = false }: { replace?: boolean } = {},
    ) => {
      const items = queuedRef.current ?? [];
      queuedRef.current = null;
      if (replace) target.reset();
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

  /**
   * Queue output again, so a re-attach gets the same ordering guarantee — on
   * a remount, and on a resync that re-attaches in place.
   */
  const closeOutput = useCallback(() => {
    queuedRef.current = [];
  }, []);

  /**
   * The pane's session ended: close the pane — unless it is being reset, whose
   * old session's exit is expected. Also what a resync does when it finds the
   * session gone, having missed this exit while its connection was down
   * (ADR-220).
   */
  const handleExit = useCallback(() => {
    if (resettingRef?.current) return;
    useAppStore.getState().closePaneById(paneId);
  }, [paneId, resettingRef]);

  useMountEffect(() => {
    const unsubOutput = window.electronAPI.pty.onOutput(
      paneId,
      (data: string, seq?: number) => {
        if (queuedRef.current)
          queuedRef.current.push({ kind: "data", chunk: { data, seq } });
        else termRef.current?.write(data);
      },
    );

    // This is also how a *follower* learns the winsize owner moved the grid
    // (ADR-178 D5): the same event, applied to the emulator the same way. The
    // grid change it causes reaches `useFollowerFit`'s `term.onResize`, which
    // re-fits the font instead of measuring the pane and sending the size
    // back — sending it back would be a loop with a pty in it, and the pty is
    // the desktop's.
    const unsubResized = window.electronAPI.pty.onResized(
      paneId,
      (cols: number, rows: number) => {
        const t = termRef.current;
        if (queuedRef.current) queuedRef.current.push({ kind: "resize", cols, rows });
        else if (t) resizeInStream(t, cols, rows);
      },
    );

    const unsubExit = window.electronAPI.pty.onExit(paneId, handleExit);

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

  return { openRestored, closeOutput, handleExit };
}
