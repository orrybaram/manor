import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useRemotePaneStore } from "../../store/remote-pane-store";
import { useHostStore } from "../../store/host-store";
import { useToastStore } from "../../store/toast-store";
import {
  isRemotePane,
  pasteClipboardImage,
  pasteImageFile,
} from "../remote-image-paste";
import { PASTED_IMAGE_CHUNK_BYTES } from "../pasted-image";
import type { PasteClipboardImageResult } from "../../electron.d";

const uploadPastedImage = vi.hoisted(() =>
  vi.fn<(paneId: string, blob: Blob) => Promise<string>>(),
);
vi.mock("../paste-image-upload", () => ({ uploadPastedImage }));

const serverHostName = vi.hoisted(() =>
  vi.fn<(hostId: string | null | undefined) => string | null>(() => null),
);
vi.mock("../../bridge/server-set", () => ({ serverHostName }));

const pasteClipboardImageIpc = vi.fn<
  (paneId: string, hostId?: string) => Promise<PasteClipboardImageResult>
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
  serverHostName.mockReturnValue(null);
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
  it("names the pane's host, which main may not know (ADR-228 D5)", async () => {
    useRemotePaneStore.getState().setPaneHost(PANE_ID, "box");
    pasteClipboardImageIpc.mockResolvedValue({ kind: "none" });

    await pasteClipboardImage(makeTerm(), PANE_ID, vi.fn());

    expect(pasteClipboardImageIpc).toHaveBeenCalledWith(PANE_ID, "box");
  });

  it("pastes the uploaded path with a trailing space", async () => {
    pasteClipboardImageIpc.mockResolvedValue({
      kind: "uploaded",
      path: "/home/user/.manor/pasted-images/20260101-000000-abcd1234.png",
    });
    const term = makeTerm();
    const fallback = vi.fn();

    await pasteClipboardImage(term, PANE_ID, fallback);

    expect(pasteClipboardImageIpc).toHaveBeenCalledWith(PANE_ID, undefined);
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

// ---------------------------------------------------------------------------
// pasteImageFile
// ---------------------------------------------------------------------------

describe("pasteImageFile", () => {
  const PATH = "/home/user/.manor/pasted-images/20260101-000000-abcd1234.png";

  function image(size: number): Blob {
    return new Blob([new Uint8Array(size)], { type: "image/png" });
  }

  it("uploads the blob and pastes its path with a trailing space", async () => {
    uploadPastedImage.mockResolvedValue(PATH);
    const term = makeTerm();
    const blob = image(10);

    await pasteImageFile(term, PANE_ID, blob);

    expect(uploadPastedImage).toHaveBeenCalledWith(PANE_ID, blob);
    expect(term.paste).toHaveBeenCalledWith(PATH + " ");
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("shows no loading toast for an image within one chunk", async () => {
    let toastsDuringUpload: unknown[] = [];
    uploadPastedImage.mockImplementation(async () => {
      toastsDuringUpload = useToastStore.getState().toasts;
      return PATH;
    });

    await pasteImageFile(makeTerm(), PANE_ID, image(PASTED_IMAGE_CHUNK_BYTES));

    expect(toastsDuringUpload).toEqual([]);
  });

  it("shows a loading toast above one chunk and removes it on success", async () => {
    useRemotePaneStore.getState().setPaneHost(PANE_ID, "box");
    let toastsDuringUpload: ReturnType<
      typeof useToastStore.getState
    >["toasts"] = [];
    uploadPastedImage.mockImplementation(async () => {
      toastsDuringUpload = useToastStore.getState().toasts;
      return PATH;
    });

    await pasteImageFile(
      makeTerm(),
      PANE_ID,
      image(PASTED_IMAGE_CHUNK_BYTES + 1),
    );

    expect(toastsDuringUpload).toHaveLength(1);
    expect(toastsDuringUpload[0]).toMatchObject({
      id: `paste-image-${PANE_ID}`,
      message: "Uploading image to box…",
      status: "loading",
    });
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("toasts an error naming the host, with the failure as detail", async () => {
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
    uploadPastedImage.mockRejectedValue(new Error("Image is too large"));
    const term = makeTerm();

    await pasteImageFile(term, PANE_ID, image(PASTED_IMAGE_CHUNK_BYTES + 1));

    expect(term.paste).not.toHaveBeenCalled();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      id: `paste-image-${PANE_ID}`,
      message: "Couldn't paste image to box.example.com",
      status: "error",
      detail: "Image is too large",
    });
  });

  it("names a relayed server by its pairing, not its room id", async () => {
    useRemotePaneStore.getState().setPaneHost(PANE_ID, "room-id");
    serverHostName.mockImplementation((id) => (id === "room-id" ? "Mac" : null));
    uploadPastedImage.mockRejectedValue(new Error("boom"));

    await pasteImageFile(makeTerm(), PANE_ID, image(10));

    expect(useToastStore.getState().toasts[0].message).toBe(
      "Couldn't paste image to Mac",
    );
  });

  it("calls an unknown host \"the host\"", async () => {
    uploadPastedImage.mockRejectedValue(new Error("boom"));

    await pasteImageFile(makeTerm(), PANE_ID, image(10));

    expect(useToastStore.getState().toasts[0].message).toBe(
      "Couldn't paste image to the host",
    );
  });
});
