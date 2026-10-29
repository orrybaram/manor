import { allUnsavedFiles, useOpenFileStore } from "../store/open-file-store";
import { isWebApp } from "./platform";

/**
 * Keep the main process told which files have unsaved edits in this
 * window, so closing the window or quitting the app asks first
 * (`electron/unsaved-files.ts`). Sends only when the list changes. Returns
 * the unsubscribe.
 */
export function reportUnsavedFiles(): () => void {
  if (isWebApp()) return () => {};
  let last: string | null = null;
  const send = () => {
    const files = allUnsavedFiles(useOpenFileStore.getState());
    const key = files.join("\0");
    if (key === last) return;
    last = key;
    window.electronAPI.window.setUnsavedFiles(files);
  };
  send();
  return useOpenFileStore.subscribe(send);
}
