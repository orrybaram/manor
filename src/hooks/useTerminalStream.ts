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
 * Also handles kitty keyboard protocol negotiation: intercepts push/pop/query
 * sequences from the child process and responds on behalf of xterm.js (which
 * does not implement the protocol natively).
 */

import { useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "../store/app-store";
import { useMountEffect } from "./useMountEffect";
import {
  outputAfterSnapshot,
  type QueuedOutput,
  type TerminalRestore,
} from "../lib/snapshot-dedupe";

// Matches kitty keyboard protocol sequences:
//   \x1b[>Xu  — push mode (flags = X, one or more digits)
//   \x1b[<u   — pop mode
//   \x1b[?u   — query current mode
const KITTY_KB_RE = /\x1b\[([>?<])(\d*)u/g;

export function useTerminalStream(
  paneId: string,
  term: Terminal | null,
  ptyWrite?: (data: string) => void,
  onError?: (message: string) => void,
  resettingRef?: React.RefObject<boolean>,
) {
  const termRef = useRef(term);
  termRef.current = term;
  const ptyWriteRef = useRef(ptyWrite);
  ptyWriteRef.current = ptyWrite;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  /** Output received so far, or null once the terminal is taking writes. */
  const queuedRef = useRef<QueuedOutput[] | null>([]);

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
      const queued = queuedRef.current ?? [];
      queuedRef.current = null;
      if (snapshot?.ansi) target.write(snapshot.ansi);
      for (const chunk of outputAfterSnapshot(queued, snapshot?.seq)) {
        target.write(chunk.data);
      }
    },
    [],
  );

  /** Queue output again, so a re-attach gets the same ordering guarantee. */
  const closeOutput = useCallback(() => {
    queuedRef.current = [];
  }, []);

  useMountEffect(() => {
    let kittyFlags = 0;

    const unsubOutput = window.electronAPI.pty.onOutput(
      paneId,
      (data: string, seq?: number) => {
        // Intercept kitty keyboard protocol sequences before xterm sees them
        let hasKitty = false;
        const filtered = data.replace(KITTY_KB_RE, (_match, prefix, digits) => {
          hasKitty = true;
          if (prefix === ">") {
            // Push keyboard mode — track the flags
            kittyFlags = parseInt(digits || "0", 10);
          } else if (prefix === "<") {
            // Pop keyboard mode
            kittyFlags = 0;
          } else if (prefix === "?") {
            // Query — respond with current flags
            ptyWriteRef.current?.(`\x1b[?${kittyFlags}u`);
          }
          return ""; // strip from output so xterm doesn't choke
        });

        const out = hasKitty ? filtered : data;
        if (queuedRef.current) queuedRef.current.push({ data: out, seq });
        else termRef.current?.write(out);
      },
    );

    const unsubExit = window.electronAPI.pty.onExit(paneId, () => {
      if (resettingRef?.current) return;
      useAppStore.getState().closePaneById(paneId);
    });

    const unsubCwd = window.electronAPI.pty.onCwd(paneId, (cwdPath: string) => {
      useAppStore.getState().setPaneCwd(paneId, cwdPath);
    });

    const unsubAgentStatus = window.electronAPI.pty.onAgentStatus(
      paneId,
      (agent) => {
        useAppStore.getState().setPaneAgentStatus(paneId, agent);
      },
    );

    const unsubError = window.electronAPI.pty.onError(
      paneId,
      (message: string) => {
        onErrorRef.current?.(message);
      },
    );

    return () => {
      unsubOutput();
      unsubExit();
      unsubCwd();
      unsubAgentStatus();
      unsubError();
    };
  });

  return { openRestored, closeOutput };
}
