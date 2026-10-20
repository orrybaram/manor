import { describe, expect, it, vi } from "vitest";
import type { HostDeps } from "../../ipc/types";
import type { HandlerCtx } from "../method";

vi.mock("electron", () => ({ safeStorage: {} }));

import {
  remoteControlSubscribePush,
  remoteControlVapidPublicKey,
} from "../handlers/remote-control";

const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };

function ctx(callerClass: "local" | "device", deviceId: string | null) {
  const subscribePush = vi.fn(() => true);
  const vapidPublicKey = vi.fn(async () => "KEY");
  const c = {
    deps: { remoteControl: { subscribePush, vapidPublicKey } } as unknown as HostDeps,
    caller: { id: "c1", callerClass, deviceId },
  } as HandlerCtx;
  return { c, subscribePush, vapidPublicKey };
}

describe("remoteControl push over the bridge", () => {
  it("stores the subscription on the calling device", async () => {
    const { c, subscribePush } = ctx("device", "dev-1");
    expect(remoteControlSubscribePush(c, sub)).toBe(true);
    expect(subscribePush).toHaveBeenCalledWith("dev-1", sub);
    await expect(remoteControlVapidPublicKey(c)).resolves.toBe("KEY");
  });

  it("refuses a local caller", () => {
    const { c, subscribePush } = ctx("local", null);
    expect(() => remoteControlSubscribePush(c, sub)).toThrow();
    expect(() => remoteControlVapidPublicKey(c)).toThrow();
    expect(subscribePush).not.toHaveBeenCalled();
  });

  it("refuses a malformed subscription", () => {
    const { c, subscribePush } = ctx("device", "dev-1");
    for (const bad of [
      null,
      "x",
      { endpoint: "http://insecure", keys: { p256dh: "p", auth: "a" } },
      { endpoint: "https://x", keys: { p256dh: "", auth: "a" } },
      { endpoint: "https://x" },
    ]) {
      expect(() => remoteControlSubscribePush(c, bad)).toThrow();
    }
    expect(subscribePush).not.toHaveBeenCalled();
  });
});
