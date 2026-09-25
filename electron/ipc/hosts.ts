/**
 * IPC for remote hosts (ADR-160 ticket 11): listing every host and its
 * connection status, adding one, removing one, and retrying a stuck
 * connection.
 *
 * Thin by design: every decision about what a host's state means, and what
 * adding or removing one does, lives in `BackendRegistry` and
 * `ProjectManager`. This only validates the boundary and wires the two
 * together — mirrors `ipc/remote-control.ts`.
 */

import crypto from "node:crypto";
import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import { assertValidTarget } from "../terminal-host/ssh-config";
import { LOCAL_HOST_ID } from "../backend/types";
import type { HostStatusInfo } from "../backend/registry";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { backendRegistry, projectManager, getRendererWindows } = deps;

  // Push the full host list to every renderer whenever any host's status
  // changes, so the settings panel and the status-bar indicator can never
  // disagree about a host's state.
  backendRegistry.onStatusChange((hosts: HostStatusInfo[]) => {
    for (const win of getRendererWindows()) {
      try {
        if (!win.webContents.mainFrame) continue;
      } catch {
        continue;
      }
      win.webContents.send("hosts:statusChanged", hosts);
    }
  });

  ipcMain.handle("hosts:list", () => backendRegistry.list());

  ipcMain.handle("hosts:add", (_event, target: unknown) => {
    assertString(target, "hosts:add.target");
    const trimmed = target.trim();
    if (trimmed === "") {
      throw new Error("An ssh target is required.");
    }
    assertValidTarget(trimmed);
    const hostId = crypto.randomUUID();
    const spec = { kind: "ssh" as const, target: trimmed };
    projectManager.saveHost(hostId, spec);
    backendRegistry.register(hostId, spec);
    backendRegistry.connectInBackground(hostId);
    return { hostId, spec };
  });

  ipcMain.handle("hosts:remove", async (_event, hostId: unknown) => {
    assertString(hostId, "hosts:remove.hostId");
    if (hostId === LOCAL_HOST_ID) {
      throw new Error(`"${LOCAL_HOST_ID}" cannot be removed.`);
    }
    if (projectManager.remoteHostIdsInUse().includes(hostId)) {
      throw new Error(
        `This host is still used by a project. Move the project to another host before removing it.`,
      );
    }
    // Forget the host synchronously, before the first await: the in-use check
    // above and this removal must be atomic with respect to a concurrent
    // `projects:update` pointing a project at this host, which would
    // otherwise slip in while the registry disconnects.
    projectManager.removeHost(hostId);
    await backendRegistry.unregister(hostId);
  });

  ipcMain.handle("hosts:retryConnect", (_event, hostId: unknown) => {
    assertString(hostId, "hosts:retryConnect.hostId");
    backendRegistry.connectInBackground(hostId);
  });
}
