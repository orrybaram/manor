import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useRemotePaneStore } from "../../store/remote-pane-store";
import { useHostStore } from "../../store/host-store";
import { useToastStore } from "../../store/toast-store";
import { isRemotePane, pasteClipboardImage } from "../remote-image-paste";
import type { PasteClipboardImageResult } from "../../electron.d";

const pasteClipboardImageIpc = vi.fn<
  (paneId: string) => Promise<PasteClipboardImageResult>
>();
(window as unknown as Record<string, unknown>).electronAPI = {
  ...(window.electronAPI as unknown as Record<string, unknown>),
  terminal: { pasteClipboardImage: pasteClipboardImageIpc },
};

const PANE_ID = "pane-1";

function makeTerm(): Terminal {
  return { paste: vi.fn() } as unknown as Terminal;
}

beforeEach(() => {
  vi.clearAllMocks();
  useRemotePaneStore.setState({ panes: {} });
  useHostStore.setState({ hosts: [] });
  useToastStore.setState({ toasts: [] });
});

// ---------------------------------------------------------------------------
// isRemotePane
// ---------------------------------------------------------------------------

describe("isRemotePane", () => {
  it("is false for a pane the store has never heard of", () => {
    expect(isRemotePane(PANE_ID)).toBe(false);
  });

  it("is false once a pane is reported as running on the local host", () => {
    useRemotePaneStore.getState().setPaneHost(PANE_ID, "local");
    expect(isRemotePane(PANE_ID)).toBe(false);
  });

  it("is true once a pane runs on a remote host", () => {
    useRemotePaneStore.getState().setPaneHost(PANE_ID, "box");
    expect(isRemotePane(PANE_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pasteClipboardImage
// ---------------------------------------------------------------------------

describe("pasteClipboardImage", () => {
  it("pastes the uploaded path with a trailing space", async () => {
    pasteClipboardImageIpc.mockResolvedValue({
      kind: "uploaded",
      path: "/home/user/.manor/pasted-images/20260101-000000-abcd1234.png",
    });
    const term = makeTerm();
    const fallback = vi.fn();

    await pasteClipboardImage(term, PANE_ID, fallback);

    expect(pasteClipboardImageIpc).toHaveBeenCalledWith(PANE_ID);
    expect(term.paste).toHaveBeenCalledWith(
      "/home/user/.manor/pasted-images/20260101-000000-abcd1234.png ",
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back for a local pane", async () => {
    pasteClipboardImageIpc.mockResolvedValue({ kind: "local" });
    const term = makeTerm();
    const fallback = vi.fn();

    await pasteClipboardImage(term, PANE_ID, fallback);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("falls back for an empty clipboard", async () => {
    pasteClipboardImageIpc.mockResolvedValue({ kind: "none" });
    const term = makeTerm();
    const fallback = vi.fn();

    await pasteClipboardImage(term, PANE_ID, fallback);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("toasts an error and does not fall back", async () => {
    useRemotePaneStore.getState().setPaneHost(PANE_ID, "box");
    useHostStore.setState({
      hosts: [
        {
          hostId: "box",
          spec: { kind: "ssh", target: "box.example.com" },
          status: "connected",
        },
      ],
    });
    pasteClipboardImageIpc.mockResolvedValue({
      kind: "error",
      message: "host unavailable",
    });
    const term = makeTerm();
    const fallback = vi.fn();

    await pasteClipboardImage(term, PANE_ID, fallback);

    expect(fallback).not.toHaveBeenCalled();
    const toast = useToastStore.getState().toasts[0];
    expect(toast.status).toBe("error");
    expect(toast.message).toBe("Couldn't paste image to box.example.com");
    expect(toast.detail).toBe("host unavailable");
  });

  it("names the host by id when no ssh target is known", async () => {
    useRemotePaneStore.getState().setPaneHost(PANE_ID, "box");
    pasteClipboardImageIpc.mockResolvedValue({
      kind: "error",
      message: "boom",
    });

    await pasteClipboardImage(makeTerm(), PANE_ID, vi.fn());

    expect(useToastStore.getState().toasts[0].message).toBe(
      "Couldn't paste image to box",
    );
  });
});
