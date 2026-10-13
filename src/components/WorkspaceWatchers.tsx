import { useBranchWatcher } from "../hooks/useBranchWatcher";
import { useDiffWatcher } from "../hooks/useDiffWatcher";
import { usePrWatcher } from "../hooks/usePrWatcher";

/**
 * Keeps every workspace's branch name, diff stat and PR current, whatever
 * shows them: the sidebar, the rail, a hidden sidebar, or the phone's chat
 * status line (the phone never mounts the sidebar). Renders nothing.
 */
export function WorkspaceWatchers() {
  useBranchWatcher();
  useDiffWatcher();
  usePrWatcher();
  return null;
}
