import { useState, useEffect, useMemo } from "react";
import type { ActivePort } from "../electron.d.ts";
import { useProjectStore } from "../store/project-store";

export interface WorkspacePortGroup {
  workspacePath: string;
  workspaceName: string;
  branch: string | null;
  ports: ActivePort[];
}

export function usePortsData() {
  const [ports, setPorts] = useState<ActivePort[]>([]);
  const projects = useProjectStore((s) => s.projects);

  // Collect all workspace paths and feed them to the scanner
  useEffect(() => {
    const paths = projects.flatMap((p) => p.workspaces.map((ws) => ws.path));
    if (paths.length > 0) {
      window.electronAPI.updateWorkspacePaths(paths);
      window.electronAPI.startPortScanner();
      // Do an immediate scan
      window.electronAPI.scanPortsNow().then(setPorts);
    }

    return () => {
      window.electronAPI.stopPortScanner();
    };
  }, [projects]);

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

    // Build a lookup from workspace path → branch name
    const branchByPath = new Map<string, string>();
    for (const project of projects) {
      for (const ws of project.workspaces) {
        if (ws.branch) branchByPath.set(ws.path, ws.branch);
      }
    }

    const result: WorkspacePortGroup[] = [];
    for (const [wsPath, wsPorts] of groups) {
      const segments = wsPath.split("/");
      result.push({
        workspacePath: wsPath,
        workspaceName: segments[segments.length - 1] || wsPath,
        branch: branchByPath.get(wsPath) ?? null,
        ports: wsPorts.sort((a, b) => a.port - b.port),
      });
    }
    return result;
  }, [ports, projects]);

  return { ports, workspacePortGroups, totalPortCount: ports.length };
}
