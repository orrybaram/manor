/**
 * The remote-control surface (ADR-161 ticket 6, ADR-180 ticket 10), as the
 * `remoteControl` namespace of the handler table.
 *
 * Thin by design: every decision — what starting a tunnel implies, what
 * disabling takes down with it — lives in `RemoteControlController`, so the
 * renderer cannot reach a half-state by calling these in an odd order.
 *
 * The raw pairing token crosses this boundary exactly once, in the return
 * value of `remoteControlPair`, and is never broadcast in a status push. That
 * return value is also why five of the seven below are `localOnly`: a stolen
 * `full` token that can pair more devices is a token that survives its own
 * revocation, which is a different class of loss
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
import type { HostDeps } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";

/**
 * The one read the ADR-178 bridge needs, lifted out of its `ipcMain.handle`
 * wrapper the way `preferencesGetAll` was — a `full` device may see who else
 * is paired and what they can do (device labels and capabilities, never
 * tokens), the same view the desktop settings panel gets.
 */
export function remoteControlGetStatus(ctx: HandlerCtx): RemoteControlStatus {
  return ctx.deps.remoteControl.status();
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
  if (value !== "tailscale") {
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
export function wireRemoteControlStatus(deps: HostDeps): void {
  deps.remoteControl.onChange((status: RemoteControlStatus) => {
    publishRendererBroadcast("remoteControl", "status", status);
  });
}

/** Re-check which tunnel binaries are on PATH. A read, with a refresh in it. */
export function remoteControlRefreshDetection(
  ctx: HandlerCtx,
): Promise<RemoteControlStatus> {
  return ctx.deps.remoteControl.refreshDetection();
}

export function remoteControlSetEnabled(
  ctx: HandlerCtx,
  enabled: boolean,
): Promise<RemoteControlStatus> {
  assertBoolean(enabled, "remoteControl.setEnabled.enabled");
  return ctx.deps.remoteControl.setEnabled(enabled);
}

/**
 * Pair a device, returning the raw token once.
 *
 * The label is trimmed and bounded here rather than in the dialog, because
 * the dialog is not the only caller any more — an empty label on a device in
 * the revoke list is a device nobody can identify well enough to revoke.
 */
export function remoteControlPair(
  ctx: HandlerCtx,
  label: string,
  capability: Capability,
): PairResult {
  assertString(label, "remoteControl.pair.label");
  assertCapability(capability, "remoteControl.pair.capability");
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new Error("A device label must be 1–64 characters.");
  }
  return ctx.deps.remoteControl.pair(trimmed, capability);
}

export function remoteControlRevoke(
  ctx: HandlerCtx,
  id: string,
): RemoteControlStatus {
  assertString(id, "remoteControl.revoke.id");
  return ctx.deps.remoteControl.revoke(id);
}

export function remoteControlStartTunnel(
  ctx: HandlerCtx,
  kind?: TunnelKind,
): Promise<RemoteControlStatus> {
  assertTunnelKind(kind, "remoteControl.startTunnel.kind");
  return ctx.deps.remoteControl.startTunnel(kind);
}

export function remoteControlStopTunnel(
  ctx: HandlerCtx,
): Promise<RemoteControlStatus> {
  return ctx.deps.remoteControl.stopTunnel();
}

export const remoteControl = {
  getStatus: method(remoteControlGetStatus),
  refreshDetection: method(remoteControlRefreshDetection),
  // A token that can pair more devices survives its own revocation, and one
  // that can turn the listener off locks the owner out of the machine they
  // are trying to take back: the five that change the exposure stay local.
  setEnabled: method(remoteControlSetEnabled, { localOnly: true }),
  pair: method(remoteControlPair, { localOnly: true }),
  revoke: method(remoteControlRevoke, { localOnly: true }),
  startTunnel: method(remoteControlStartTunnel, { localOnly: true }),
  stopTunnel: method(remoteControlStopTunnel, { localOnly: true }),
};
