/**
 * The desktop transport, over a fake `manorHost`.
 *
 * Three things this adapter decides, and nothing else: that a namespace the
 * preload still answers is called in process rather than sent anywhere, that
 * a call that is not goes out as one invoke frame, and that the result frame
 * `ipcMain.handle` answers with is settled the way the socket's is. The
 * channels themselves are `electron/bridge/transports/ipc.ts`'s and are
 * tested there.
 */

import { describe, it, expect, vi } from "vitest";

import type { ResultFrame } from "../../../electron/bridge/types";
import { BridgeUnavailableError, createBridge } from "../client";
import { createIpcTransport } from "../transports/ipc";
import type { ManorHost } from "../../electron";

/** A host whose every invoke is answered with `frame`, id aside. */
function answering(
  frame:
    | { ok: true; result: unknown }
    | { ok: false; error: string; code: string },
): ManorHost["invoke"] {
  return vi.fn((sent: { id: unknown }) =>
    Promise.resolve({ id: sent.id, kind: "result", ...frame } as ResultFrame),
  );
}

function hostWith(overrides: Partial<ManorHost> = {}): ManorHost {
  return {
    platform: "electron",
    rendererId: "3",
    claim: null,
    env: { isPackaged: false },
    native: {} as ManorHost["native"],
    invoke: answering({ ok: true, result: undefined }),
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
          claim: { workspacePath: "/w", tabId: "t1" },
          env: { isPackaged: true },
        }),
      ),
    );
    expect(api.platform).toBe("electron");
    expect(api.rendererId).toBe("12");
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

  describe("a call that was not served in process", () => {
    it("goes out as one invoke frame and resolves with the result", async () => {
      const host = hostWith({
        invoke: answering({ ok: true, result: [{ id: 1 }] }),
      });
      const api = createBridge(createIpcTransport(host));
      await expect(api.projects.getAll()).resolves.toEqual([{ id: 1 }]);
      expect(host.invoke).toHaveBeenCalledWith({
        kind: "invoke",
        id: expect.anything(),
        ns: "projects",
        method: "getAll",
        args: [],
      });
    });

    it("throws an unavailable result as BridgeUnavailableError", async () => {
      const host = hostWith({
        invoke: answering({
          ok: false,
          code: "unavailable:web",
          error: "The host does not do that",
        }),
      });
      const pending = createBridge(createIpcTransport(host)).projects.getAll();
      await expect(pending).rejects.toBeInstanceOf(BridgeUnavailableError);
      await expect(pending).rejects.toThrow("The host does not do that");
    });

    it("throws any other failure as a plain Error", async () => {
      const host = hostWith({
        invoke: answering({
          ok: false,
          code: "failed",
          error: "expected a string",
        }),
      });
      const pending = createBridge(createIpcTransport(host)).pty.write(
        "pane-a",
        "ls\r",
      );
      await expect(pending).rejects.toThrow("expected a string");
      await expect(pending).rejects.not.toBeInstanceOf(BridgeUnavailableError);
    });
  });
});
