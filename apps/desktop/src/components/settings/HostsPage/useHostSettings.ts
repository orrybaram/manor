import { useState } from "react";
import type { HostServerView } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { useHostStore } from "../../../store/host-store";

/** Runs one of a host's actions, keeping its error until the next. */
export type RunAction = (work: () => Promise<void>) => void;

/** The busy flag and last error of a host's switches and buttons. */
export function useHostAction(): { busy: boolean; error: string | null; run: RunAction } {
  const [action, setAction] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });

  const run: RunAction = (work) => {
    setAction({ busy: true, error: null });
    work().then(
      () => setAction({ busy: false, error: null }),
      (err: unknown) => setAction({ busy: false, error: ipcErrorMessage(err) }),
    );
  };

  return { ...action, run };
}

/**
 * What a host's settings read: its server's view, asked for on mount, and
 * whether this computer has a Linear key to hand it.
 */
export function useHostSettings(
  hostId: string,
  readOnly: boolean,
): { view: HostServerView | null; desktopLinear: boolean } {
  const view = useHostStore((s) => s.servers[hostId]) ?? null;
  const [desktopLinear, setDesktopLinear] = useState(false);

  useMountEffect(() => {
    // The switches read the server's view; a browser can't ask.
    if (readOnly) return;
    void useHostStore.getState().refreshServer(hostId);
    const refresh = () => void window.electronAPI.linear.isConnected().then(setDesktopLinear);
    refresh();
    // The key was saved or cleared elsewhere.
    return window.electronAPI.linear.onConnectionChanged(refresh);
  });

  return { view, desktopLinear };
}
