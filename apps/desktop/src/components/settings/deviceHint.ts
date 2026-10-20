import { relativeShort } from "../../utils/relative-time";
import type { RemoteDeviceInfo } from "../../electron.d";

/** Minutes left, rounded up, at least 1. */
export function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 60_000));
}

/** The hint under a device's name, by state: active, waiting or expired. */
export function deviceHint(device: RemoteDeviceInfo, now: number): string {
  if (device.pending) {
    return device.pending.expiresAt > now
      ? `Waiting for the device to open the link · expires in ${minutesLeft(device.pending.expiresAt, now)} min`
      : "Link expired";
  }
  return `Paired ${relativeShort(device.createdAt)} · ${
    device.lastSeenAt === null
      ? "not connected yet"
      : `last seen ${relativeShort(device.lastSeenAt)}`
  }`;
}
