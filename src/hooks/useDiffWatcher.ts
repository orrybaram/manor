import { useEffect, useRef } from "react";
import { useProjectStore } from "../store/project-store";

export function useDiffWatcher() {
  const projects = useProjectStore((s) => s.projects);
  const updateWorkspaceDiffStats = useProjectStore(
    (s) => s.updateWorkspaceDiffStats,
  );

  // Build a stable map of workspacePath → defaultBranch
  const prevMapRef = useRef<Record<string, string>>({});
  const workspaceMap = (() => {
    const next: Record<string, string> = {};
    for (const p of projects) {
      for (const ws of p.workspaces) {
        next[ws.path] = p.defaultBranch;
      }
    }
    const prev = prevMapRef.current;
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    if (
      prevKeys.length === nextKeys.length &&
      nextKeys.every((k) => prev[k] === next[k])
    ) {
      return prev;
    }
    prevMapRef.current = next;
    return next;
  })();

  useEffect(() => {
    if (Object.keys(workspaceMap).length === 0) return;

    window.electronAPI.diffs.start(workspaceMap);

    return () => {
      window.electronAPI.diffs.stop();
    };
  }, [workspaceMap]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.diffs.onChange((diffs) => {
      // Get all workspace paths to clear stats for workspaces with no diff
      const allPaths = Object.keys(prevMapRef.current);
      for (const wsPath of allPaths) {
        updateWorkspaceDiffStats(wsPath, diffs[wsPath] ?? null);
      }
    });
    return unsubscribe;
  }, [updateWorkspaceDiffStats]);
}
