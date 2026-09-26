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
import { assertBoolean, assertString } from "../ipc-validate";
import type { RemoteControlStatus } from "../remote-control/controller";
import { CAPABILITIES, isCapability } from "../remote-control/devices";
import type { Capability } from "../remote-control/devices";
import type { TunnelKind } from "../remote-control/tunnel";
import { publishRendererBroadcast } from "../renderer-broadcast";
import type { IpcDeps } from "./types";

/**
 * The one read the ADR-178 bridge needs, lifted out of its `ipcMain.handle`
 * wrapper the way `preferencesGetAll` was — a `full` device may see who else
 * is paired and what they can do (device labels and capabilities, never
 * tokens), the same view the desktop settings panel gets.
 */
export function remoteControlGetStatus(deps: IpcDeps): RemoteControlStatus {
  return deps.remoteControl.status();
}

/**
 * The tier is a string off the renderer, so it is checked against the three
 * literals rather than cast. An unrecognised value is an error and not a
 * silent fall back to `read`: a pairing that quietly granted less than the
 * user chose would be reported as a bug, and one that quietly granted more
 * would be a great deal worse.
 */
function assertCapability(
  value: unknown,
  name: string,
): asserts value is Capability {
  if (!isCapability(value)) {
    throw new Error(
      `${name}: expected one of ${CAPABILITIES.join(", ")}, got ${String(value)}`,
    );
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
  // exposure indicator can never disagree about whether we are reachable. A
  // web renderer has no `webContents`; `publishRendererBroadcast` is the
  // second sink that reaches it over the bridge (ADR-178 D8).
  remoteControl.onChange((status: RemoteControlStatus) => {
    publishRendererBroadcast("remoteControl", "status", status);
    for (const win of getRendererWindows()) {
      try {
        if (!win.webContents.mainFrame) continue;
      } catch {
        continue;
      }
      win.webContents.send("remoteControl:status", status);
    }
  });

  ipcMain.handle("remoteControl:getStatus", () =>
    remoteControlGetStatus(deps),
  );

  ipcMain.handle("remoteControl:refreshDetection", () =>
    remoteControl.refreshDetection(),
  );

  ipcMain.handle("remoteControl:setEnabled", (_event, enabled: unknown) => {
    assertBoolean(enabled, "remoteControl:setEnabled.enabled");
    return remoteControl.setEnabled(enabled);
  });

  ipcMain.handle(
    "remoteControl:pair",
    (_event, label: unknown, capability: unknown) => {
      assertString(label, "remoteControl:pair.label");
      assertCapability(capability, "remoteControl:pair.capability");
      const trimmed = label.trim();
      if (trimmed.length === 0 || trimmed.length > 64) {
        throw new Error("A device label must be 1–64 characters.");
      }
      return remoteControl.pair(trimmed, capability);
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
