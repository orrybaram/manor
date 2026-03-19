import { useEffect, useRef } from "react";
import { useProjectStore } from "../store/project-store";

export function useBranchWatcher() {
  const projects = useProjectStore((s) => s.projects);
  const updateWorkspaceBranch = useProjectStore((s) => s.updateWorkspaceBranch);

  // Stabilize paths: only produce a new reference when the actual path values change.
  // This prevents the watcher from restarting when branches update in the store.
  const prevPathsRef = useRef<string[]>([]);
  const paths = (() => {
    const next = projects.flatMap((p) => p.workspaces.map((ws) => ws.path));
    const prev = prevPathsRef.current;
    if (
      next.length === prev.length &&
      next.every((p, i) => p === prev[i])
    ) {
      return prev;
    }
    prevPathsRef.current = next;
    return next;
  })();

  // Start/stop watcher with paths in a single IPC call — no race conditions
  useEffect(() => {
    if (paths.length === 0) return;

    window.electronAPI.startBranchWatcher(paths);

    return () => {
      window.electronAPI.stopBranchWatcher();
    };
  }, [paths]);

  // Subscribe to branch change events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onBranchesChanged((branches) => {
      for (const [wsPath, branch] of Object.entries(branches)) {
        updateWorkspaceBranch(wsPath, branch);
      }
    });
    return unsubscribe;
  }, [updateWorkspaceBranch]);
}
