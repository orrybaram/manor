import { useEffect, useRef } from "react";
import { useProjectStore, type DiffStats } from "../store/project-store";
import { keyOf } from "../lib/workspace-directory";
import type { WorkspaceKey } from "../lib/workspace-key";
import { useMountEffect } from "./useMountEffect";

export function useDiffWatcher() {
  const projects = useProjectStore((s) => s.projects);
  const updateWorkspaceDiffStats = useProjectStore(
    (s) => s.updateWorkspaceDiffStats,
  );

  // Build a stable map of WorkspaceKey → { path, defaultBranch, hostId } —
  // each workspace travels with its project's host (ADR-183), and is keyed by
  // it so two hosts' identical paths stay apart (ADR-204).
  type Entry = { path: string; defaultBranch: string; hostId: string };
  const prevMapRef = useRef<Record<WorkspaceKey, Entry>>({});
  const workspaceMap = (() => {
    const next: Record<WorkspaceKey, Entry> = {};
    for (const p of projects) {
      for (const ws of p.workspaces) {
        next[keyOf(p, ws)] = {
          path: ws.path,
          defaultBranch: p.defaultBranch,
          hostId: p.hostId,
        };
      }
    }
    const prev = prevMapRef.current;
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next) as WorkspaceKey[];
    if (
      prevKeys.length === nextKeys.length &&
      nextKeys.every(
        (k) =>
          prev[k]?.path === next[k].path &&
          prev[k]?.defaultBranch === next[k].defaultBranch &&
          prev[k]?.hostId === next[k].hostId,
      )
    ) {
      return prev;
    }
    prevMapRef.current = next;
    return next;
  })();

  // Start/stop watcher when workspaceMap changes
  useEffect(() => {
    const workspaces = Object.values(workspaceMap);
    if (workspaces.length > 0) {
      window.electronAPI.diffs.start(workspaces);
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
  const latestDiffsRef = useRef<Record<WorkspaceKey, DiffStats>>({});
  const applyDiffs = (diffs: Record<WorkspaceKey, DiffStats>) => {
    // One update for every watched workspace; null clears one with no diff.
    const stats: Record<WorkspaceKey, DiffStats | null> = {};
    for (const key of Object.keys(prevMapRef.current) as WorkspaceKey[]) {
      stats[key] = diffs[key] ?? null;
    }
    updateWorkspaceDiffStats(stats);
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
