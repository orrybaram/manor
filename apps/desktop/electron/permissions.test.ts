import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RequestHandler = (
  wc: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>,
) => void;

const handlers: { request?: RequestHandler } = {};
const showMessageBox = vi.fn();

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  session: {
    defaultSession: {
      setPermissionRequestHandler: (h: RequestHandler) =>
        (handlers.request = h),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
    },
  },
}));

import { allowTabCapture, installPermissionPolicy } from "./permissions";

/** A browser pane's guest, as the request handler sees it. */
function guest(id: number) {
  return {
    id,
    isDestroyed: () => false,
    getURL: () => "https://example.com/",
  } as unknown as Electron.WebContents;
}

function request(wc: unknown, mediaTypes: string[]): Promise<boolean> {
  return new Promise((resolve) =>
    handlers.request!(wc, "media", resolve, {
      requestingUrl: "https://example.com/",
      isMainFrame: true,
      mediaTypes,
    }),
  );
}

describe("tab capture passes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    showMessageBox.mockReset().mockResolvedValue({ response: 0 });
    installPermissionPolicy();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("grants the recorder's capture of a guest without asking, once", async () => {
    const wc = guest(1);
    allowTabCapture(wc);
    await expect(request(wc, ["video"])).resolves.toBe(true);
    expect(showMessageBox).not.toHaveBeenCalled();

    // The pass is spent: the page asking for its camera is asked about.
    await expect(request(wc, ["video"])).resolves.toBe(false);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("accepts a capture that names no device type, as Electron sends one", async () => {
    const wc = guest(6);
    allowTabCapture(wc);
    await expect(request(wc, [])).resolves.toBe(true);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it("covers only that guest", async () => {
    allowTabCapture(guest(2));
    await expect(request(guest(3), ["video"])).resolves.toBe(false);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("doesn't cover a microphone", async () => {
    const wc = guest(4);
    allowTabCapture(wc);
    await expect(request(wc, ["audio", "video"])).resolves.toBe(false);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("lapses when unused", async () => {
    const wc = guest(5);
    allowTabCapture(wc);
    vi.advanceTimersByTime(5_001);
    await expect(request(wc, ["video"])).resolves.toBe(false);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });
});
