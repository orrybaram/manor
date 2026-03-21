import { useRef } from "react";
import { useProjectStore } from "../store/project-store";
import { useMountEffect } from "./useMountEffect";

export function useBranchWatcher() {
  const projects = useProjectStore((s) => s.projects);
  const updateWorkspaceBranch = useProjectStore((s) => s.updateWorkspaceBranch);

  // Stabilize paths: only produce a new reference when the actual path values change.
  // This prevents the watcher from restarting when branches update in the store.
  const prevPathsRef = useRef<string[]>([]);
  const paths = (() => {
    const next = projects.flatMap((p) => p.workspaces.map((ws) => ws.path));
    const prev = prevPathsRef.current;
    if (next.length === prev.length && next.every((p, i) => p === prev[i])) {
      return prev;
    }
    prevPathsRef.current = next;
    return next;
  })();

  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  // Start/stop watcher with paths — uses store subscription to react to changes
  useMountEffect(() => {
    let currentPaths = pathsRef.current;
    if (currentPaths.length > 0) {
      window.electronAPI.branches.start(currentPaths);
    }

    const unsub = useProjectStore.subscribe(() => {
      const nextPaths = pathsRef.current;
      if (nextPaths !== currentPaths) {
        currentPaths = nextPaths;
        if (currentPaths.length > 0) {
          window.electronAPI.branches.start(currentPaths);
        } else {
          window.electronAPI.branches.stop();
        }
      }
    });

    return () => {
      unsub();
      window.electronAPI.branches.stop();
    };
  });

  // Subscribe to branch change events
  useMountEffect(() => {
    const unsubscribe = window.electronAPI.branches.onChange((branches) => {
      for (const [wsPath, branch] of Object.entries(branches)) {
        updateWorkspaceBranch(wsPath, branch);
      }
    });
    return unsubscribe;
  });
}
