import { useMemo } from "react";
import type { ActivePort } from "../../electron.d.ts";
import { useProjectStore } from "../../store/project-store";
import { usePortsStore, acquirePortsScanner } from "../../store/ports-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { find } from "../../lib/workspace-directory";
import {
  parseWorkspaceKey,
  workspaceKey,
  type WorkspaceKey,
} from "../../lib/workspace-key";

export interface WorkspacePortGroup {
  /** The workspace the ports belong to: its path on the ports' host (ADR-204). */
  key: WorkspaceKey;
  workspacePath: string;
  /** The host the group's ports listen on. */
  hostId: string;
  workspaceName: string;
  branch: string | null;
  projectName: string | null;
  isMain: boolean;
  ports: ActivePort[];
}

export function usePortsData() {
  const ports = usePortsStore((s) => s.ports);
  const projects = useProjectStore((s) => s.projects);

  // The scanner is shared: it starts with the first consumer and stops with the last.
  useMountEffect(() => acquirePortsScanner());

  // Group ports by workspace. A local and a remote workspace can share a
  // path, so group by key, not by path.
  const workspacePortGroups = useMemo(() => {
    const groups = new Map<WorkspaceKey, ActivePort[]>();
    for (const port of ports) {
      if (!port.workspacePath) continue;
      const key = workspaceKey(port.hostId, port.workspacePath);
      const existing = groups.get(key);
      if (existing) {
        existing.push(port);
      } else {
        groups.set(key, [port]);
      }
    }

    const result: WorkspacePortGroup[] = [];
    for (const [key, wsPorts] of groups) {
      const { path: wsPath } = parseWorkspaceKey(key);
      const segments = wsPath.split("/");
      const found = find(projects, key);
      result.push({
        key,
        workspacePath: wsPath,
        hostId: wsPorts[0].hostId,
        workspaceName: segments[segments.length - 1] || wsPath,
        branch: found?.workspace.branch || null,
        projectName: found?.project.name ?? null,
        isMain: found?.workspace.isMain ?? false,
        ports: wsPorts.sort((a, b) => a.port - b.port),
      });
    }
    return result;
  }, [ports, projects]);

  return { ports, workspacePortGroups, totalPortCount: ports.length };
}
