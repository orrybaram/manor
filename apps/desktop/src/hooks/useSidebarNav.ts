import { useCallback } from "react";
import { HOME_PATH } from "../lib/home";
import { useAppStore } from "../store/app-store";

/**
 * The Dashboard and Tasks nav actions shared by the desk sidebar and the
 * phone drawer. Each runs `onNavigate` after switching, which the drawer uses
 * to close itself.
 */
export function useSidebarNav(onNavigate?: () => void): {
  selectHome: () => void;
  showTasks: () => void;
} {
  const selectHome = useCallback(() => {
    useAppStore.getState().setActiveWorkspace(HOME_PATH);
    onNavigate?.();
  }, [onNavigate]);

  const showTasks = useCallback(() => {
    useAppStore.getState().showTasksView();
    onNavigate?.();
  }, [onNavigate]);

  return { selectHome, showTasks };
}
