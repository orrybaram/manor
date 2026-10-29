import { useEffect, useRef } from "react";
import { useUpdaterStore } from "../store/updater-store";
import { toast } from "../toast";

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
        // An update was found and downloaded. `checking` stays true from the
        // check until the download completes, so the "checking finished" branch
        // below never fires (it requires pending === null). Dismiss the stuck
        // "Checking for updates…" loading toast here before showing this one.
        toast.dismiss("updater-checking");
        toast.success(`Manor ${pending.version} ready to install`, {
          id: "updater-pending",
          duration: "sticky",
          action: {
            label: "Restart now",
            onClick: () => window.electronAPI.updater.quitAndInstall(),
          },
          secondaryAction: {
            label: "Later",
            onClick: () => toast.dismiss("updater-pending"),
          },
        });
      }

      // --- checking started: manual only ---
      if (checking && !prev.checking && lastTriggerWasManual) {
        toast.progress("Checking for updates…", { id: "updater-checking" });
      }

      // --- checking finished: manual, no update, no error ---
      if (!checking && prev.checking && lastTriggerWasManual && pending === null && error === null) {
        toast.success("You’re on the latest version", { id: "updater-checking" });
      }

      // --- error: manual only ---
      if (error !== null && prev.error === null && lastTriggerWasManual) {
        toast.error("Couldn’t check for updates", { id: "updater-checking", detail: error });
      }

      prevRef.current = { checking, pending, error };
    });

    return unsubscribe;
  }, []);
}
