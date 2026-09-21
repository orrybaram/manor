/**
 * The desktop transport, over a fake `manorHost` (ADR-180 ticket 3).
 *
 * Three things this adapter decides, and nothing else: that a namespace the
 * preload still answers is called in process rather than sent anywhere, that
 * a root-level preload *function* is served as a locally-served member rather
 * than mistaken for a namespace, and that the `{__bridgeError}` value
 * `ipcMain.handle` forces the host to return becomes the error it should have
 * been. The channels themselves are `electron/bridge/transports/ipc.ts`'s and
 * are tested there.
 */

import { describe, it, expect, vi } from "vitest";

import { BridgeUnavailableError, createBridge } from "../client";
import { createIpcTransport } from "../transports/ipc";
import type { ManorHost } from "../../electron";

function hostWith(overrides: Partial<ManorHost> = {}): ManorHost {
  return {
    platform: "electron",
    rendererId: "3",
    isDetached: false,
    detachedWindowId: null,
    claim: null,
    env: { isPackaged: false },
    native: {} as ManorHost["native"],
    invoke: vi.fn(() => Promise.resolve(undefined)),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe("createIpcTransport", () => {
  it("reads the preload's facts synchronously", () => {
    const api = createBridge(
      createIpcTransport(
        hostWith({
          rendererId: "12",
          isDetached: true,
          detachedWindowId: "win-1",
          claim: { workspacePath: "/w", tabId: "t1" },
          env: { isPackaged: true },
        }),
      ),
    );
    expect(api.platform).toBe("electron");
    expect(api.rendererId).toBe("12");
    expect(api.isDetached).toBe(true);
    expect(api.detachedWindowId).toBe("win-1");
    expect(api.claim).toEqual({ workspacePath: "/w", tabId: "t1" });
    expect(api.env.isPackaged).toBe(true);
  });

  it("calls a namespace the preload still answers, without a frame", () => {
    const write = vi.fn(() => Promise.resolve());
    const host = hostWith({ native: { pty: { write } } as never });
    const api = createBridge(createIpcTransport(host));

    void api.pty.write("pane-a", "ls\r");
    expect(write).toHaveBeenCalledWith("pane-a", "ls\r");
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("subscribes through the preload, with the paneId as the key", () => {
    const host = hostWith();
    const cb = vi.fn();
    createBridge(createIpcTransport(host)).pty.onOutput("pane-a", cb);
    expect(host.subscribe).toHaveBeenCalledWith(
      "pty",
      "output",
      "pane-a",
      expect.any(Function),
    );
  });

  it("names a null key for an event about the machine", () => {
    const host = hostWith();
    createBridge(createIpcTransport(host)).preferences.onChange(() => {});
    expect(host.subscribe).toHaveBeenCalledWith(
      "preferences",
      "changed",
      null,
      expect.any(Function),
    );
  });

  /**
   * A function on `native` is a root member of `ElectronAPI`, not a
   * namespace: `onAppCommand`, `onProjectsChanged`, `sendAppCommandResult`.
   * Without this they would each resolve to a namespace proxy and a call
   * would be a `TypeError` on an object, not a rejected promise.
   */
  it("serves a root-level preload function as itself", () => {
    const onProjectsChanged = vi.fn(() => () => {});
    const sendAppCommandResult = vi.fn();
    const host = hostWith({
      native: { onProjectsChanged, sendAppCommandResult } as never,
    });
    const api = createBridge(createIpcTransport(host));

    expect(api.onProjectsChanged(() => {})).toBeTypeOf("function");
    api.sendAppCommandResult({ requestId: "r1" } as never);

    expect(onProjectsChanged).toHaveBeenCalledOnce();
    expect(sendAppCommandResult).toHaveBeenCalledWith({ requestId: "r1" });
    expect(host.subscribe).not.toHaveBeenCalled();
    expect(host.invoke).not.toHaveBeenCalled();
  });

  describe("a call that was not served in process", () => {
    it("goes over invoke and resolves with the result", async () => {
      const host = hostWith({
        invoke: vi.fn(() => Promise.resolve([{ id: 1 }])),
      });
      const api = createBridge(createIpcTransport(host));
      await expect(api.projects.getAll()).resolves.toEqual([{ id: 1 }]);
      expect(host.invoke).toHaveBeenCalledWith("projects", "getAll", []);
    });

    it("throws the unavailable envelope as BridgeUnavailableError", async () => {
      const host = hostWith({
        invoke: vi.fn(() =>
          Promise.resolve({
            __bridgeError: {
              code: "unavailable:web",
              message: "The host does not do that",
            },
          }),
        ),
      });
      const pending = createBridge(createIpcTransport(host)).projects.getAll();
      await expect(pending).rejects.toBeInstanceOf(BridgeUnavailableError);
      await expect(pending).rejects.toThrow("The host does not do that");
    });

    it("throws any other envelope as a plain Error", async () => {
      const host = hostWith({
        invoke: vi.fn(() =>
          Promise.resolve({
            __bridgeError: { code: "failed", message: "expected a string" },
          }),
        ),
      });
      const pending = createBridge(createIpcTransport(host)).pty.write(
        "pane-a",
        "ls\r",
      );
      await expect(pending).rejects.toThrow("expected a string");
      await expect(pending).rejects.not.toBeInstanceOf(BridgeUnavailableError);
    });

    it("passes a result that merely looks like an envelope through", async () => {
      const host = hostWith({
        invoke: vi.fn(() => Promise.resolve({ __bridgeError: "nope" })),
      });
      await expect(
        createBridge(createIpcTransport(host)).projects.getAll(),
      ).resolves.toEqual({ __bridgeError: "nope" });
    });
  });
});
