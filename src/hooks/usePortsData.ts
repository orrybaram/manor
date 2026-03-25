import { useState, useMemo } from "react";
import type { ActivePort } from "../electron.d.ts";
import { useProjectStore } from "../store/project-store";
import { useMountEffect } from "./useMountEffect";

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

  // Scanner setup: subscribe to store changes to detect when workspace paths change,
  // and restart the scanner accordingly.
  useMountEffect(() => {
    const getPaths = () =>
      useProjectStore
        .getState()
        .projects.flatMap((p) => p.workspaces.map((ws) => ws.path));

    const getMeta = () =>
      useProjectStore.getState().projects.flatMap((p) =>
        p.workspaces.map((ws) => ({
          path: ws.path,
          projectName: p.name,
          branch: ws.branch ?? null,
          isMain: ws.isMain,
        })),
      );

    let currentPathsKey = "";

    const setup = (paths: string[]) => {
      if (paths.length > 0) {
        window.electronAPI.ports.updateWorkspacePaths(paths);
        window.electronAPI.ports.updateWorkspaceMetadata(getMeta());
        window.electronAPI.ports.startScanner();
        window.electronAPI.ports.scanNow().then(setPorts);
      }
    };

    // Initial setup
    const initialPaths = getPaths();
    currentPathsKey = initialPaths.join("\0");
    setup(initialPaths);

    // Re-setup when paths change
    const unsub = useProjectStore.subscribe(() => {
      const newPaths = getPaths();
      const newKey = newPaths.join("\0");
      if (newKey !== currentPathsKey) {
        currentPathsKey = newKey;
        setup(newPaths);
      }
    });

    return () => {
      unsub();
      window.electronAPI.ports.stopScanner();
    };
  });

  // Subscribe to port change events
  useMountEffect(() => {
    const unsubscribe = window.electronAPI.ports.onChange((newPorts) => {
      setPorts(newPorts as ActivePort[]);
    });
    return unsubscribe;
  });

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
