/**
 * ADR-206 D7, browser side: permission is asked only from the tap and before
 * any `await` (WebKit needs the user activation), the mount path never asks,
 * a subscription bound to another VAPID key is replaced, and nothing
 * subscribes before the service worker is active.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enablePush, resubscribePush } from "../web-push";

const KEY_BYTES = new Uint8Array(65).fill(4);
const KEY = btoa(String.fromCharCode(...KEY_BYTES))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

interface FakeSubscription {
  options: { applicationServerKey: ArrayBuffer | null };
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => unknown;
}

function subscription(key: Uint8Array | null, id: string): FakeSubscription {
  return {
    options: {
      applicationServerKey: key ? new Uint8Array(key).buffer : null,
    },
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({ endpoint: id }),
  };
}

class FakeWorker extends EventTarget {
  state = "installing";
  become(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

describe("web push", () => {
  let permission: NotificationPermission;
  let requestPermission: ReturnType<typeof vi.fn>;
  let existing: FakeSubscription | null;
  let subscribe: ReturnType<typeof vi.fn>;
  let subscribePush: ReturnType<typeof vi.fn>;
  let register: ReturnType<typeof vi.fn>;
  let registration: {
    active: FakeWorker | null;
    installing: FakeWorker | null;
    waiting: FakeWorker | null;
    pushManager: { getSubscription: () => unknown; subscribe: unknown };
  };

  beforeEach(() => {
    permission = "default";
    requestPermission = vi.fn(async () => {
      permission = "granted";
      return permission;
    });
    vi.stubGlobal("Notification", {
      get permission() {
        return permission;
      },
      requestPermission,
    });
    existing = null;
    subscribe = vi.fn(async () => subscription(KEY_BYTES, "fresh"));
    registration = {
      active: new FakeWorker(),
      installing: null,
      waiting: null,
      pushManager: {
        getSubscription: async () => existing,
        subscribe,
      },
    };
    register = vi.fn(async () => registration);
    vi.stubGlobal("navigator", {
      userAgent: "test",
      maxTouchPoints: 0,
      serviceWorker: { register },
    });
    subscribePush = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      PushManager: class {},
      Notification: {},
      electronAPI: {
        platform: "web",
        remoteControl: {
          vapidPublicKey: vi.fn().mockResolvedValue(KEY),
          subscribePush,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for permission synchronously, before any await", async () => {
    const pending = enablePush();
    // Still inside the tap's call stack: nothing has been awaited yet.
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe("on");
    expect(subscribePush).toHaveBeenCalledWith({ endpoint: "fresh" });
  });

  it("does not ask again once permission is granted", async () => {
    permission = "granted";
    await expect(enablePush()).resolves.toBe("on");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("does not ask when permission is denied", async () => {
    permission = "denied";
    await expect(enablePush()).resolves.toBe("denied");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("stays on offer when the prompt is dismissed", async () => {
    requestPermission.mockResolvedValueOnce("default");
    await expect(enablePush()).resolves.toBe("offer");
    expect(register).not.toHaveBeenCalled();
  });

  it("never asks on mount", async () => {
    await expect(resubscribePush()).resolves.toBe("offer");
    permission = "denied";
    await expect(resubscribePush()).resolves.toBe("denied");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("re-sends the existing subscription on mount when granted", async () => {
    permission = "granted";
    existing = subscription(KEY_BYTES, "kept");
    await expect(resubscribePush()).resolves.toBe("on");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscribePush).toHaveBeenCalledWith({ endpoint: "kept" });
  });

  it.each([
    ["another desktop's key", new Uint8Array(65).fill(5)],
    ["a key of another length", new Uint8Array(32).fill(4)],
    ["no key it can report", null],
  ])("replaces a subscription bound to %s", async (_, key) => {
    permission = "granted";
    const stale = subscription(key, "stale");
    existing = stale;
    await expect(resubscribePush()).resolves.toBe("on");
    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    const options = subscribe.mock.calls[0][0] as {
      applicationServerKey: Uint8Array;
    };
    expect([...options.applicationServerKey]).toEqual([...KEY_BYTES]);
    expect(subscribePush).toHaveBeenCalledWith({ endpoint: "fresh" });
  });

  it("waits for the service worker to activate before subscribing", async () => {
    permission = "granted";
    const worker = new FakeWorker();
    registration.active = null;
    registration.installing = worker;
    const pending = resubscribePush();
    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    await Promise.resolve();
    expect(subscribe).not.toHaveBeenCalled();
    worker.become("installed");
    expect(subscribe).not.toHaveBeenCalled();
    registration.active = worker;
    worker.become("activated");
    await expect(pending).resolves.toBe("on");
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("fails when the service worker does not install", async () => {
    permission = "granted";
    const worker = new FakeWorker();
    registration.active = null;
    registration.installing = worker;
    const pending = resubscribePush();
    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    worker.become("redundant");
    await expect(pending).rejects.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("hides the control when the host has no VAPID key", async () => {
    permission = "granted";
    (
      window as unknown as {
        electronAPI: {
          remoteControl: { vapidPublicKey: ReturnType<typeof vi.fn> };
        };
      }
    ).electronAPI.remoteControl.vapidPublicKey.mockResolvedValue(null);
    await expect(resubscribePush()).resolves.toBe("hidden");
    expect(register).not.toHaveBeenCalled();
  });
});
