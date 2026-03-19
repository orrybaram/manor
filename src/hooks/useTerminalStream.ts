/**
 * useTerminalStream — subscribes to PTY output, exit, and CWD events.
 */

import { useEffect } from "react";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "../store/app-store";

export function useTerminalStream(
  paneId: string,
  term: Terminal | null,
) {
  useEffect(() => {
    if (!term) return;

    const unsubOutput = window.electronAPI.onPtyOutput(paneId, (data: string) => {
      term.write(data);
    });

    const unsubExit = window.electronAPI.onPtyExit(paneId, () => {
      term.write("\r\n[Process exited]\r\n");
    });

    const unsubCwd = window.electronAPI.onPtyCwd(paneId, (cwdPath: string) => {
      useAppStore.getState().setPaneCwd(paneId, cwdPath);
    });

    return () => {
      unsubOutput();
      unsubExit();
      unsubCwd();
    };
  }, [paneId, term]);
}
