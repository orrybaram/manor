import { describe, expect, it } from "vitest";
import { deviceHint } from "../deviceHint";
import type { RemoteDeviceInfo } from "../../../electron.d";

const base: RemoteDeviceInfo = {
  id: "d1",
  label: "Phone",
  createdAt: 0,
  lastSeenAt: null,
  hasPush: false,
};

describe("deviceHint", () => {
  it("says waiting with minutes rounded up", () => {
    const hint = deviceHint({ ...base, pending: { expiresAt: 150_000 } }, 0);
    expect(hint).toBe(
      "Waiting for the device to open the link · expires in 3 min",
    );
  });
  it("says expired once past expiresAt", () => {
    expect(deviceHint({ ...base, pending: { expiresAt: 10 } }, 20)).toBe(
      "Link expired",
    );
  });
  it("keeps the active copy", () => {
    expect(deviceHint(base, Date.now())).toContain("not connected yet");
  });
});
