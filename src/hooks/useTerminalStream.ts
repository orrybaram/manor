/**
 * useTerminalStream — subscribes to PTY output, exit, and CWD events.
 *
 * Also handles kitty keyboard protocol negotiation: intercepts push/pop/query
 * sequences from the child process and responds on behalf of xterm.js (which
 * does not implement the protocol natively).
 */

import { useEffect } from "react";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "../store/app-store";

// Matches kitty keyboard protocol sequences:
//   \x1b[>Xu  — push mode (flags = X, one or more digits)
//   \x1b[<u   — pop mode
//   \x1b[?u   — query current mode
const KITTY_KB_RE = /\x1b\[([>?<])(\d*)u/g;

export function useTerminalStream(
  paneId: string,
  term: Terminal | null,
  ptyWrite?: (data: string) => void,
) {
  useEffect(() => {
    if (!term) return;

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
            ptyWrite?.(`\x1b[?${kittyFlags}u`);
          }
          return ""; // strip from output so xterm doesn't choke
        });

        term.write(hasKitty ? filtered : data);
      },
    );

    const unsubExit = window.electronAPI.pty.onExit(paneId, () => {
      term.write("\r\n[Process exited]\r\n");
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

    return () => {
      unsubOutput();
      unsubExit();
      unsubCwd();
      unsubAgentStatus();
    };
  }, [paneId, term, ptyWrite]);
}
