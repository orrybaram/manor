/**
 * The remote-control surface, as the `remoteControl` namespace of the
 * handler table.
 *
 * Thin by design: every decision — what starting the relay implies, what
 * disabling takes down with it — lives in `RemoteControlController`, so the
 * renderer cannot reach a half-state by calling these in an odd order.
 *
 * A pairing link crosses this boundary exactly once, in the return value of
 * `remoteControlPair` or `remoteControlReissue`, and is never broadcast in a
 * status push. That return value is also why seven of the eleven below are
 * `localOnly`: a stolen device token that can pair more devices is a token
 * that survives its own revocation, which is a different class of loss from
 * "can remove a workspace" — the one accepted knowingly.
 * `getStatus` is a read and stays open, so a device's own settings page is
 * not lying to it about the surface it is on; the two push methods are for
 * paired devices only.
 *
 * There is no `register()` here any more. What is left of it is
 * `wireRemoteControlStatus`, which was never an IPC handler: it is the one
 * subscription that turns a controller change into a push.
 */

import { assertBoolean, assertString } from "../../ipc-validate";
import type { LinkedHostPairing } from "../../remote-control/host-links";
import type {
  RemoteControlController,
  RemoteControlStatus,
} from "../../remote-control/controller";
import type { PairResult } from "../../remote-control/relay-room";
import { asPushSubscription } from "../../remote-control/push";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { ServerDeps } from "../../ipc/types";
import { method, type Caller, type HandlerCtx } from "../method";

/**
 * A handler that reads only `keys` of the remote-control surface. The host
 * server reuses these over its own relay, pairing and push,
 * which have the same shape and none of the desktop's enable/disable.
 */
type RemoteControlCtx<K extends keyof RemoteControlController> = HandlerCtx<{
  remoteControl: Pick<RemoteControlController, K>;
}>;

/**
 * The one read the bridge needs, lifted out of its `ipcMain.handle`
 * wrapper the way `preferencesGetAll` was — a paired device may see who else
 * is paired (device labels, never tokens), the same view the desktop settings
 * panel gets.
 */
export function remoteControlGetStatus(
  ctx: HandlerCtx<ServerDeps>,
): RemoteControlStatus {
  return ctx.deps.remoteControl.status();
}

/**
 * Push status to every viewer so the settings panel and the persistent
 * exposure indicator can never disagree about whether we are reachable.
 *
 * Never an `ipcMain.handle`, which is why it outlived `register()`: the
 * `webContents.send("remoteControl:status")` loop beside it is gone, and `publishRendererBroadcast` now reaches a desktop window and a
 * paired device through the one sink — `remoteControl.status`, which is what
 * `remoteControl.onStatus(cb)` subscribes to on both platforms.
 */
export function wireRemoteControlStatus(
  deps: Pick<ServerDeps, "remoteControl">,
): void {
  deps.remoteControl.onChange((status: RemoteControlStatus) => {
    publishRendererBroadcast("remoteControl", "status", status);
  });
}

export function remoteControlSetEnabled(
  ctx: HandlerCtx<ServerDeps>,
  enabled: boolean,
): Promise<RemoteControlStatus> {
  assertBoolean(enabled, "remoteControl.setEnabled.enabled");
  return ctx.deps.remoteControl.setEnabled(enabled);
}

/**
 * Pair a device through the relay, returning its pairing link once: a
 * single-use ticket by default, or with `{ direct: true }` the device's raw
 * token as well.
 *
 * The label is trimmed and bounded here rather than in the dialog, because
 * the dialog is not the only caller any more — an empty label on a device in
 * the revoke list is a device nobody can identify well enough to revoke.
 */
export function remoteControlPair(
  ctx: RemoteControlCtx<"pair">,
  label: string,
  options?: { direct?: boolean },
): Promise<PairResult> {
  assertString(label, "remoteControl.pair.label");
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new Error("A device label must be 1–64 characters.");
  }
  return ctx.deps.remoteControl.pair(trimmed, asPairOptions(options));
}

/** `options` as the store reads it, or a throw for anything else. */
function asPairOptions(options: unknown): { direct?: boolean } | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("remoteControl.pair.options must be an object");
  }
  const { direct, ...rest } = options as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new Error("remoteControl.pair.options may only set direct");
  }
  if (direct === undefined) return {};
  if (typeof direct !== "boolean") {
    throw new Error("remoteControl.pair.options.direct must be a boolean");
  }
  return { direct };
}

/**
 * A new link for a device that has not connected yet; the old
 * one is dead. Local only, like `pair`: a link is a way in.
 */
export function remoteControlReissue(
  ctx: RemoteControlCtx<"reissue">,
  id: string,
): Promise<PairResult> {
  assertString(id, "remoteControl.reissue.id");
  return ctx.deps.remoteControl.reissue(id);
}

/**
 * Revoking a device also revokes the pairings it was given on each remote
 * host: the device store hands them to `HostPairingLinks`,
 * which revokes each now, or on that host's next connect.
 */
export function remoteControlRevoke(
  ctx: HandlerCtx<ServerDeps>,
  id: string,
): Promise<RemoteControlStatus> {
  assertString(id, "remoteControl.revoke.id");
  return ctx.deps.remoteControl.revoke(id);
}

export function remoteControlStartRelay(
  ctx: HandlerCtx<ServerDeps>,
): Promise<RemoteControlStatus> {
  return ctx.deps.remoteControl.startRelay();
}

export function remoteControlStopRelay(
  ctx: HandlerCtx<ServerDeps>,
): Promise<RemoteControlStatus> {
  return ctx.deps.remoteControl.stopRelay();
}

/** New relay address; every paired device is revoked. */
export function remoteControlResetRelayAddress(
  ctx: HandlerCtx<ServerDeps>,
): Promise<RemoteControlStatus> {
  return ctx.deps.remoteControl.resetRelayAddress();
}

/**
 * Push, over the bridge — the only way a device
 * subscribes. Device callers only — a desktop window has no device to subscribe — and the
 * subscription lands on the calling connection's device, never one the frame
 * names.
 */
export function remoteControlVapidPublicKey(
  ctx: RemoteControlCtx<"vapidPublicKey">,
): Promise<string | null> {
  assertDevice(ctx.caller);
  return ctx.deps.remoteControl.vapidPublicKey();
}

export function remoteControlSubscribePush(
  ctx: RemoteControlCtx<"subscribePush">,
  subscription: unknown,
): true {
  const deviceId = assertDevice(ctx.caller);
  const record = asPushSubscription(subscription);
  if (!record) throw new Error("Expected a push subscription");
  if (!ctx.deps.remoteControl.subscribePush(deviceId, record)) {
    throw new Error("Push is not available");
  }
  return true;
}

/** How many held rooms a device may name: far more than anyone pairs. */
const MAX_HELD_ROOMS = 256;

/**
 * One pairing covers every host: pair the calling device with
 * each remote host's server it can reach and does not already hold a room
 * for, and hand it what it needs to dial each — inside its own Noise
 * channel. The phone calls it on every hello from this desktop, so a host
 * added later, or away the last time, is picked up on a later connect.
 *
 * **Not `localOnly`**, though it hands out pairings, which is what keeps
 * `pair` local:
 * - a `full` device on this desktop already reaches every host through
 *   `HostRouting`. A direct pairing adds no reach; it only lets the device
 *   keep it while this desktop sleeps;
 * - it pairs only the caller, whose device this desktop paired itself, under
 *   that device's own label — never a device the frame names;
 * - every pairing is linked to the caller's device here, so revoking the
 *   device revokes them too (`HostPairingLinks`). A stolen token that mints
 *   host pairings loses them with its own revocation.
 *
 * `mutating`, for the audit line: it adds a phone to each host's list. A
 * desktop window has no device to pair, and gets an empty list.
 */
export function remoteControlLinkHostPairings(
  ctx: HandlerCtx<ServerDeps>,
  heldRooms: string[],
): Promise<LinkedHostPairing[]> {
  if (
    !Array.isArray(heldRooms as unknown) ||
    heldRooms.length > MAX_HELD_ROOMS ||
    !heldRooms.every((room) => typeof room === "string")
  ) {
    throw new Error("remoteControl.linkHostPairings.heldRooms must be a list of room ids");
  }
  const { callerClass, deviceId } = ctx.caller;
  const links = ctx.deps.hostLinks;
  if (callerClass !== "device" || !deviceId || !links) return Promise.resolve([]);
  return links.link(deviceId, heldRooms);
}

function assertDevice({ callerClass, deviceId }: Caller): string {
  if (callerClass !== "device" || !deviceId) {
    throw new Error("Push subscriptions are for paired devices only.");
  }
  return deviceId;
}

export const remoteControl = {
  getStatus: method(remoteControlGetStatus),
  // A token that can pair more devices survives its own revocation, and one
  // that can turn remote control off locks the owner out of the machine they
  // are trying to take back: the seven that change the exposure stay local.
  vapidPublicKey: method(remoteControlVapidPublicKey),
  subscribePush: method(remoteControlSubscribePush),
  // A device's own pairings on the hosts; why it is not local, in the doc.
  linkHostPairings: method(remoteControlLinkHostPairings, { mutating: true }),
  setEnabled: method(remoteControlSetEnabled, { localOnly: true }),
  pair: method(remoteControlPair, { localOnly: true }),
  reissue: method(remoteControlReissue, { localOnly: true }),
  revoke: method(remoteControlRevoke, { localOnly: true }),
  startRelay: method(remoteControlStartRelay, { localOnly: true }),
  stopRelay: method(remoteControlStopRelay, { localOnly: true }),
  resetRelayAddress: method(remoteControlResetRelayAddress, {
    localOnly: true,
  }),
};
