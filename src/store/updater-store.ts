import { create } from "zustand";

export interface UpdaterState {
  pending: { version: string } | null;
  lastChecked: number | null;
  checking: boolean;
  lastTriggerWasManual: boolean;
  error: string | null;

  triggerManualCheck: () => void;
  clearPending: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
  pending: null,
  lastChecked: null,
  checking: false,
  lastTriggerWasManual: false,
  error: null,

  triggerManualCheck: () => {
    set({ lastTriggerWasManual: true });
    window.electronAPI?.updater.checkForUpdates();
  },

  clearPending: () => set({ pending: null }),
}));

// Subscribe to updater events at module-init scope so the store stays current
// regardless of which component reads it first.
const u = window.electronAPI?.updater;
if (u) {
  u.onChecking(({ manual }) => {
    useUpdaterStore.setState({ checking: true, lastTriggerWasManual: manual, error: null });
  });

  u.onUpdateNotAvailable(({ manual: _manual }) => {
    useUpdaterStore.setState({ checking: false, lastChecked: Date.now() });
  });

  u.onUpdateAvailable((_info) => {
    // No state change — we wait for update-downloaded.
    // Optionally bump lastChecked so the UI knows a check completed.
    useUpdaterStore.setState({ lastChecked: Date.now() });
  });

  u.onUpdateDownloaded((info) => {
    useUpdaterStore.setState({ checking: false, pending: info, lastChecked: Date.now() });
  });

  u.onError(({ message }) => {
    useUpdaterStore.setState({ checking: false, error: message, lastChecked: Date.now() });
  });
}
