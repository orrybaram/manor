import { useEffect, useRef } from "react";
import { useUpdaterStore } from "../store/updater-store";
import { useToastStore } from "../store/toast-store";

interface PrevState {
  checking: boolean;
  pending: { version: string } | null;
  error: string | null;
}

export function useUpdaterToasts() {
  const prevRef = useRef<PrevState>({
    checking: false,
    pending: null,
    error: null,
  });

  useEffect(() => {
    const unsubscribe = useUpdaterStore.subscribe((state) => {
      const prev = prevRef.current;
      const { checking, pending, error, lastTriggerWasManual } = state;

      // --- pending becomes non-null: always show, regardless of trigger ---
      if (pending !== null && prev.pending === null) {
        useToastStore.getState().addToast({
          id: "updater-pending",
          status: "success",
          message: `Manor ${pending.version} ready to install`,
          persistent: true,
          action: {
            label: "Restart now",
            onClick: () => window.electronAPI.updater.quitAndInstall(),
          },
          secondaryAction: {
            label: "Later",
            onClick: () => useToastStore.getState().removeToast("updater-pending"),
          },
        });
      }

      // --- checking started: manual only ---
      if (checking && !prev.checking && lastTriggerWasManual) {
        useToastStore.getState().addToast({
          id: "updater-checking",
          status: "loading",
          message: "Checking for updates…",
        });
      }

      // --- checking finished: manual, no update, no error ---
      if (!checking && prev.checking && lastTriggerWasManual && pending === null && error === null) {
        useToastStore.getState().addToast({
          id: "updater-checking",
          status: "success",
          message: "You’re on the latest version",
        });
      }

      // --- error: manual only ---
      if (error !== null && prev.error === null && lastTriggerWasManual) {
        useToastStore.getState().addToast({
          id: "updater-checking",
          status: "error",
          message: "Couldn’t check for updates",
          detail: error,
        });
      }

      prevRef.current = { checking, pending, error };
    });

    return unsubscribe;
  }, []);
}
