import { useState, useEffect, useMemo, useRef } from "react";
import type { ActivePort } from "../electron.d.ts";
import { useProjectStore } from "../store/project-store";

export interface WorkspacePortGroup {
  workspacePath: string;
  workspaceName: string;
  branch: string | null;
  projectName: string | null;
  isMain: boolean;
  ports: ActivePort[];
}

export function usePortsData() {
  const [ports, setPorts] = useState<ActivePort[]>([]);
  const projects = useProjectStore((s) => s.projects);

  // Derive a stable paths key so the scanner only restarts when paths actually change
  const paths = useMemo(
    () => projects.flatMap((p) => p.workspaces.map((ws) => ws.path)),
    [projects],
  );
  const pathsKey = paths.join("\0");
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  // Collect all workspace paths and feed them to the scanner
  useEffect(() => {
    const currentPaths = pathsRef.current;
    if (currentPaths.length > 0) {
      window.electronAPI.updateWorkspacePaths(currentPaths);
      window.electronAPI.startPortScanner();
      // Do an immediate scan
      window.electronAPI.scanPortsNow().then(setPorts);
    }

    return () => {
      window.electronAPI.stopPortScanner();
    };
  }, [pathsKey]);

  // Subscribe to port change events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onPortsChanged((newPorts) => {
      setPorts(newPorts as ActivePort[]);
    });
    return unsubscribe;
  }, []);

  // Group ports by workspace
  const workspacePortGroups = useMemo(() => {
    const groups = new Map<string, ActivePort[]>();
    for (const port of ports) {
      if (!port.workspacePath) continue;
      const existing = groups.get(port.workspacePath);
      if (existing) {
        existing.push(port);
      } else {
        groups.set(port.workspacePath, [port]);
      }
    }

    // Build lookups from workspace path → info
    const branchByPath = new Map<string, string>();
    const isMainByPath = new Map<string, boolean>();
    const projectNameByPath = new Map<string, string>();
    for (const project of projects) {
      for (const ws of project.workspaces) {
        if (ws.branch) branchByPath.set(ws.path, ws.branch);
        isMainByPath.set(ws.path, ws.isMain);
        projectNameByPath.set(ws.path, project.name);
      }
    }

    const result: WorkspacePortGroup[] = [];
    for (const [wsPath, wsPorts] of groups) {
      const segments = wsPath.split("/");
      result.push({
        workspacePath: wsPath,
        workspaceName: segments[segments.length - 1] || wsPath,
        branch: branchByPath.get(wsPath) ?? null,
        projectName: projectNameByPath.get(wsPath) ?? null,
        isMain: isMainByPath.get(wsPath) ?? false,
        ports: wsPorts.sort((a, b) => a.port - b.port),
      });
    }
    return result;
  }, [ports, projects]);

  return { ports, workspacePortGroups, totalPortCount: ports.length };
}
