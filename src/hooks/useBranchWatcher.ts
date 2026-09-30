import { useEffect, useRef } from "react";
import { useProjectStore } from "../store/project-store";
import { useMountEffect } from "./useMountEffect";

export function useBranchWatcher() {
  const projects = useProjectStore((s) => s.projects);
  const updateWorkspaceBranches = useProjectStore(
    (s) => s.updateWorkspaceBranches,
  );

  // Stabilize workspaces (each with its project's host, ADR-183): only
  // produce a new reference when a path or host actually changes. This
  // prevents the watcher from restarting when branches update in the store.
  const prevPathsRef = useRef<Array<{ path: string; hostId: string }>>([]);
  const paths = (() => {
    const next = projects.flatMap((p) =>
      p.workspaces.map((ws) => ({ path: ws.path, hostId: p.hostId })),
    );
    const prev = prevPathsRef.current;
    if (
      next.length === prev.length &&
      next.every((w, i) => w.path === prev[i].path && w.hostId === prev[i].hostId)
    ) {
      return prev;
    }
    prevPathsRef.current = next;
    return next;
  })();

  // Start/stop watcher when workspaces change
  useEffect(() => {
    if (paths.length > 0) {
      window.electronAPI.branches.start(paths);
    } else {
      window.electronAPI.branches.stop();
    }
    return () => {
      window.electronAPI.branches.stop();
    };
  }, [paths]);

  // Subscribe to branch change events
  useMountEffect(() => {
    const unsubscribe = window.electronAPI.branches.onChange((branches) => {
      updateWorkspaceBranches(branches);
    });
    return unsubscribe;
  });
}
