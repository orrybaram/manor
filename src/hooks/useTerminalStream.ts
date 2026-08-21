/**
 * useTerminalStream — subscribes to PTY output, exit, and CWD events.
 *
 * Owns the whole PTY-bytes-to-xterm path, including its opening move: output is
 * queued until the caller calls `openOutput(term)`. The daemon subscribes us to
 * the session's stream before the create/attach reply gets back here, so live
 * bytes would otherwise land in xterm *before* the warm-restore snapshot, and
 * the snapshot would then repeat everything the terminal had already shown.
 *
 * Also handles kitty keyboard protocol negotiation: intercepts push/pop/query
 * sequences from the child process and responds on behalf of xterm.js (which
 * does not implement the protocol natively).
 */

import { useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "../store/app-store";
import { useMountEffect } from "./useMountEffect";

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
  const queuedRef = useRef<string[] | null>([]);

  /**
   * Start writing output through, replaying whatever arrived while queued.
   * Takes the terminal explicitly so the caller doesn't have to assume React
   * has re-rendered with it by the time the create/attach round trip lands.
   */
  const openOutput = useCallback((target: Terminal) => {
    const queued = queuedRef.current;
    queuedRef.current = null;
    if (queued) for (const chunk of queued) target.write(chunk);
  }, []);

  useMountEffect(() => {
    let kittyFlags = 0;

    const unsubOutput = window.electronAPI.pty.onOutput(
      paneId,
      (data: string) => {
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
        if (queuedRef.current) queuedRef.current.push(out);
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

  return { openOutput };
}
