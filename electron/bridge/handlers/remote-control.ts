/**
 * The remote-control surface, as the `remoteControl` namespace of the
 * handler table.
 *
 * Thin by design: every decision — what starting the relay implies, what
 * disabling takes down with it — lives in `RemoteControlController`, so the
 * renderer cannot reach a half-state by calling these in an odd order.
 *
 * The raw pairing token crosses this boundary exactly once, in the return
 * value of `remoteControlPair`, and is never broadcast in a status push. That
 * return value is also why six of the nine below are `localOnly`: a stolen
 * `full` token that can pair more devices is a token that survives its own
 * revocation, which is a different class of loss
 * from "can remove a workspace" — the one ADR-178 D3 accepted knowingly.
 * `getStatus` is a read and stays open, so a device's own settings page is
 * not lying to it about the surface it is on; the two push methods are for
 * paired devices only.
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
import {
  CAPABILITIES,
  isCapability,
  isPairedVia,
} from "../../remote-control/devices";
import type { Capability, PairedVia } from "../../remote-control/devices";
import { asPushSubscription } from "../../remote-control/push";
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
  via: PairedVia = "tailscale",
): PairResult {
  assertString(label, "remoteControl.pair.label");
  assertCapability(capability, "remoteControl.pair.capability");
  if (!isPairedVia(via)) {
    throw new Error(`remoteControl.pair.via: got ${String(via)}`);
  }
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new Error("A device label must be 1–64 characters.");
  }
  return ctx.deps.remoteControl.pair(trimmed, capability, via);
}

export function remoteControlRevoke(
  ctx: HandlerCtx,
  id: string,
): RemoteControlStatus {
  assertString(id, "remoteControl.revoke.id");
  return ctx.deps.remoteControl.revoke(id);
}

export function remoteControlStartRelay(
  ctx: HandlerCtx,
): Promise<RemoteControlStatus> {
  return ctx.deps.remoteControl.startRelay();
}

export function remoteControlStopRelay(
  ctx: HandlerCtx,
): Promise<RemoteControlStatus> {
  return ctx.deps.remoteControl.stopRelay();
}

/** New relay address; every device paired through the relay is revoked. */
export function remoteControlResetRelayAddress(
  ctx: HandlerCtx,
): Promise<RemoteControlStatus> {
  return ctx.deps.remoteControl.resetRelayAddress();
}

/**
 * Push, over the bridge (ADR-206 D7): a relay-paired web app cannot call
 * `POST /push/subscribe`, so the same store path is reachable here. Device
 * callers only — a desktop window has no device to subscribe — and the
 * subscription lands on the calling connection's device, never one the frame
 * names.
 */
export function remoteControlVapidPublicKey(
  ctx: HandlerCtx,
): Promise<string | null> {
  assertDevice(ctx);
  return ctx.deps.remoteControl.vapidPublicKey();
}

export function remoteControlSubscribePush(
  ctx: HandlerCtx,
  subscription: unknown,
): true {
  const deviceId = assertDevice(ctx);
  const record = asPushSubscription(subscription);
  if (!record) throw new Error("Expected a push subscription");
  if (!ctx.deps.remoteControl.subscribePush(deviceId, record)) {
    throw new Error("Push is not available");
  }
  return true;
}

function assertDevice(ctx: HandlerCtx): string {
  const { callerClass, deviceId } = ctx.caller;
  if (callerClass !== "device" || !deviceId) {
    throw new Error("Push subscriptions are for paired devices only.");
  }
  return deviceId;
}

export const remoteControl = {
  getStatus: method(remoteControlGetStatus),
  // A token that can pair more devices survives its own revocation, and one
  // that can turn remote control off locks the owner out of the machine they
  // are trying to take back: the six that change the exposure stay local.
  vapidPublicKey: method(remoteControlVapidPublicKey),
  subscribePush: method(remoteControlSubscribePush),
  setEnabled: method(remoteControlSetEnabled, { localOnly: true }),
  pair: method(remoteControlPair, { localOnly: true }),
  revoke: method(remoteControlRevoke, { localOnly: true }),
  startRelay: method(remoteControlStartRelay, { localOnly: true }),
  stopRelay: method(remoteControlStopRelay, { localOnly: true }),
  resetRelayAddress: method(remoteControlResetRelayAddress, {
    localOnly: true,
  }),
};
