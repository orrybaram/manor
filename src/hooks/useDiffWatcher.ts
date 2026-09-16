import { useEffect, useRef } from "react";
import { useProjectStore, type DiffStats } from "../store/project-store";
import { useMountEffect } from "./useMountEffect";

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

  // Start/stop watcher when workspaceMap changes
  useEffect(() => {
    if (Object.keys(workspaceMap).length > 0) {
      window.electronAPI.diffs.start(workspaceMap);
    } else {
      window.electronAPI.diffs.stop();
    }
    return () => {
      window.electronAPI.diffs.stop();
    };
  }, [workspaceMap]);

  // The main process only emits when stats change, so keep the latest payload
  // around. Reloading projects (e.g. on `projects-changed`) replaces workspace
  // objects and drops `diffStats`; re-apply the cached stats when that happens.
  const latestDiffsRef = useRef<Record<string, DiffStats>>({});
  const applyDiffs = (diffs: Record<string, DiffStats>) => {
    // Clear stats for workspaces with no diff
    for (const wsPath of Object.keys(prevMapRef.current)) {
      updateWorkspaceDiffStats(wsPath, diffs[wsPath] ?? null);
    }
  };

  useEffect(() => {
    applyDiffs(latestDiffsRef.current);
  }, [projects]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to diff change events
  useMountEffect(() => {
    const unsubscribe = window.electronAPI.diffs.onChange((diffs) => {
      latestDiffsRef.current = diffs;
      applyDiffs(diffs);
    });
    return unsubscribe;
  });
}
