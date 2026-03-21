import { useEffect } from "react";
import { useToastStore } from "../store/toast-store";

export function useAutoUpdate() {
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    if (!window.electronAPI?.updater?.onUpdateDownloaded) return;

    const cleanup = window.electronAPI.updater.onUpdateDownloaded(
      ({ version }: { version: string }) => {
        addToast({
          id: "auto-update-ready",
          message: `Update v${version} ready — restart to apply. Your sessions will be preserved.`,
          status: "success",
          persistent: true,
          action: {
            label: "Restart",
            onClick: () => window.electronAPI.updater.quitAndInstall(),
          },
        });
      },
    );

    return cleanup;
  }, [addToast]);
}
