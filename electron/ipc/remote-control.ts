/**
 * IPC for the remote-control surface (ADR-161 ticket 6).
 *
 * Thin by design: every decision — what starting a tunnel implies, what
 * disabling takes down with it — lives in `RemoteControlController`, so the
 * renderer cannot reach a half-state by calling these in an odd order.
 *
 * The raw pairing token crosses this boundary exactly once, in the return
 * value of `remoteControl:pair`, and is never broadcast in a status push.
 */

import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import type { RemoteControlStatus } from "../remote-control/controller";
import type { TunnelKind } from "../remote-control/tunnel";
import type { IpcDeps } from "./types";

function assertBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name}: expected boolean, got ${typeof value}`);
  }
}

function assertTunnelKind(
  value: unknown,
  name: string,
): asserts value is TunnelKind | undefined {
  if (value === undefined) return;
  if (value !== "tailscale" && value !== "cloudflared") {
    throw new Error(`${name}: expected a tunnel kind, got ${String(value)}`);
  }
}

export function register(deps: IpcDeps): void {
  const { remoteControl, getRendererWindows } = deps;

  // Push status to every renderer so the settings panel and the persistent
  // exposure indicator can never disagree about whether we are reachable.
  remoteControl.onChange((status: RemoteControlStatus) => {
    for (const win of getRendererWindows()) {
      try {
        if (!win.webContents.mainFrame) continue;
      } catch {
        continue;
      }
      win.webContents.send("remoteControl:status", status);
    }
  });

  ipcMain.handle("remoteControl:getStatus", () => remoteControl.status());

  ipcMain.handle("remoteControl:refreshDetection", () =>
    remoteControl.refreshDetection(),
  );

  ipcMain.handle("remoteControl:setEnabled", (_event, enabled: unknown) => {
    assertBoolean(enabled, "remoteControl:setEnabled.enabled");
    return remoteControl.setEnabled(enabled);
  });

  ipcMain.handle(
    "remoteControl:pair",
    (_event, label: unknown, canSend: unknown) => {
      assertString(label, "remoteControl:pair.label");
      assertBoolean(canSend, "remoteControl:pair.canSend");
      const trimmed = label.trim();
      if (trimmed.length === 0 || trimmed.length > 64) {
        throw new Error("A device label must be 1–64 characters.");
      }
      return remoteControl.pair(trimmed, canSend);
    },
  );

  ipcMain.handle("remoteControl:revoke", (_event, id: unknown) => {
    assertString(id, "remoteControl:revoke.id");
    return remoteControl.revoke(id);
  });

  ipcMain.handle("remoteControl:startTunnel", (_event, kind: unknown) => {
    assertTunnelKind(kind, "remoteControl:startTunnel.kind");
    return remoteControl.startTunnel(kind);
  });

  ipcMain.handle("remoteControl:stopTunnel", () => remoteControl.stopTunnel());
}
