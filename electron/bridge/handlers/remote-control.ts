/**
 * The remote-control surface, as plain functions over `IpcDeps` (ADR-161
 * ticket 6, lifted for ADR-180 D4/D8 ticket 10).
 *
 * Thin by design: every decision — what starting a tunnel implies, what
 * disabling takes down with it — lives in `RemoteControlController`, so the
 * renderer cannot reach a half-state by calling these in an odd order.
 *
 * The raw pairing token crosses this boundary exactly once, in the return
 * value of `remoteControlPair`, and is never broadcast in a status push. That
 * return value is also why five of the seven below are `LOCAL_ONLY`
 * (`handlers.ts`): a stolen `full` token that can pair more devices is a
 * token that survives its own revocation, which is a different class of loss
 * from "can remove a workspace" — the one ADR-178 D3 accepted knowingly.
 * `getStatus` and `refreshDetection` are reads and stay open, so a device's
 * own settings page is not lying to it about the surface it is on.
 *
 * There is no `register()` here any more. What is left of it is
 * `wireRemoteControlStatus`, which was never an IPC handler: it is the one
 * subscription that turns a controller change into a push.
 */

import { assertBoolean, assertString } from "../../ipc-validate";
import type {
  PairResult,
  RemoteControlStatus,
} from "../../remote-control/controller";
import { CAPABILITIES, isCapability } from "../../remote-control/devices";
import type { Capability } from "../../remote-control/devices";
import type { TunnelKind } from "../../remote-control/tunnel";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { IpcDeps } from "../../ipc/types";

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

/**
 * Push status to every viewer so the settings panel and the persistent
 * exposure indicator can never disagree about whether we are reachable.
 *
 * Never an `ipcMain.handle`, which is why it outlived `register()`: the
 * `webContents.send("remoteControl:status")` loop beside it is gone (ADR-180
 * D5), and `publishRendererBroadcast` now reaches a desktop window and a
 * paired device through the one sink — `remoteControl.status`, which is what
 * `remoteControl.onStatus(cb)` subscribes to on both platforms.
 */
export function wireRemoteControlStatus(deps: IpcDeps): void {
  deps.remoteControl.onChange((status: RemoteControlStatus) => {
    publishRendererBroadcast("remoteControl", "status", status);
  });
}

/** Re-check which tunnel binaries are on PATH. A read, with a refresh in it. */
export function remoteControlRefreshDetection(
  deps: IpcDeps,
): Promise<RemoteControlStatus> {
  return deps.remoteControl.refreshDetection();
}

export function remoteControlSetEnabled(
  deps: IpcDeps,
  enabled: unknown,
): Promise<RemoteControlStatus> {
  assertBoolean(enabled, "remoteControl.setEnabled.enabled");
  return deps.remoteControl.setEnabled(enabled);
}

/**
 * Pair a device, returning the raw token once.
 *
 * The label is trimmed and bounded here rather than in the dialog, because
 * the dialog is not the only caller any more — an empty label on a device in
 * the revoke list is a device nobody can identify well enough to revoke.
 */
export function remoteControlPair(
  deps: IpcDeps,
  label: unknown,
  capability: unknown,
): PairResult {
  assertString(label, "remoteControl.pair.label");
  assertCapability(capability, "remoteControl.pair.capability");
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new Error("A device label must be 1–64 characters.");
  }
  return deps.remoteControl.pair(trimmed, capability);
}

export function remoteControlRevoke(
  deps: IpcDeps,
  id: unknown,
): RemoteControlStatus {
  assertString(id, "remoteControl.revoke.id");
  return deps.remoteControl.revoke(id);
}

export function remoteControlStartTunnel(
  deps: IpcDeps,
  kind: unknown,
): Promise<RemoteControlStatus> {
  assertTunnelKind(kind, "remoteControl.startTunnel.kind");
  return deps.remoteControl.startTunnel(kind);
}

export function remoteControlStopTunnel(
  deps: IpcDeps,
): Promise<RemoteControlStatus> {
  return deps.remoteControl.stopTunnel();
}
