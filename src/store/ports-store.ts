import { create } from "zustand";
import type { ActivePort } from "../electron.d.ts";
import { useProjectStore } from "./project-store";

/**
 * The listening-ports list, fed by ONE scanner (ADR-198 §7). The sidebar's
 * `PortsList` and Home's project tiles both read it; each consumer holds a
 * reference through `acquirePortsScanner`, and the scanner runs while at
 * least one is held.
 */
type PortsState = {
  ports: ActivePort[];
  setPorts: (ports: ActivePort[]) => void;
};

export const usePortsStore = create<PortsState>((set) => ({
  ports: [],
  setPorts: (ports) => set({ ports }),
}));

/** Start the scanner and keep it aimed at the project store's workspaces; returns the stop function. */
function startScanner(): () => void {
  const { setPorts } = usePortsStore.getState();

  // Each workspace travels with its project's host (ADR-183).
  const getWorkspaces = () =>
    useProjectStore
      .getState()
      .projects.flatMap((p) => p.workspaces.map((ws) => ({ path: ws.path, hostId: p.hostId })));

  const getMeta = () =>
    useProjectStore.getState().projects.flatMap((p) =>
      p.workspaces.map((ws) => ({
        path: ws.path,
        hostId: p.hostId,
        projectName: p.name,
        branch: ws.branch ?? null,
        isMain: ws.isMain,
        portlessEnabled: p.portlessEnabled !== false,
      })),
    );

  let currentPathsKey = "";
  let currentMetaKey = "";

  const setup = (workspaces: Array<{ path: string; hostId: string }>) => {
    if (workspaces.length > 0) {
      window.electronAPI.ports.updateWorkspaces(workspaces);
      window.electronAPI.ports.updateWorkspaceMetadata(getMeta());
      window.electronAPI.ports.startScanner();
      window.electronAPI.ports.scanNow().then(setPorts);
    }
  };

  const initialWorkspaces = getWorkspaces();
  currentPathsKey = JSON.stringify(initialWorkspaces);
  currentMetaKey = JSON.stringify(getMeta());
  setup(initialWorkspaces);

  // Re-setup when paths change; re-push metadata (and rescan, so hostnames
  // are recomputed) when only the metadata changed — e.g. the portless
  // toggle or a project rename.
  const unsubProjects = useProjectStore.subscribe(() => {
    const newWorkspaces = getWorkspaces();
    const newKey = JSON.stringify(newWorkspaces);
    if (newKey !== currentPathsKey) {
      currentPathsKey = newKey;
      currentMetaKey = JSON.stringify(getMeta());
      setup(newWorkspaces);
      return;
    }
    const newMetaKey = JSON.stringify(getMeta());
    if (newMetaKey !== currentMetaKey) {
      currentMetaKey = newMetaKey;
      window.electronAPI.ports.updateWorkspaceMetadata(getMeta());
      window.electronAPI.ports.scanNow().then(setPorts);
    }
  });

  const unsubChange = window.electronAPI.ports.onChange((newPorts) => {
    setPorts(newPorts as ActivePort[]);
  });

  return () => {
    unsubProjects();
    unsubChange();
    window.electronAPI.ports.stopScanner();
  };
}

let holders = 0;
let stop: (() => void) | null = null;

/**
 * Hold a reference to the shared scanner: the first holder starts it, the
 * last release stops it. Returns the release function (idempotent).
 */
export function acquirePortsScanner(start: () => () => void = startScanner): () => void {
  if (holders === 0) stop = start();
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) {
      stop?.();
      stop = null;
    }
  };
}
