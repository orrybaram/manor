import { describe, it, expect, beforeEach, vi } from "vitest";
import { PasteImageError, uploadPastedImage } from "../paste-image-upload";
import {
  MAX_PASTED_IMAGE_BYTES,
  PASTED_IMAGE_CHUNK_BYTES,
} from "../pasted-image";

const begin = vi.fn();
const chunk = vi.fn();
const commit = vi.fn();
const abort = vi.fn();
(window as unknown as Record<string, unknown>).electronAPI = {
  ...(window.electronAPI as unknown as Record<string, unknown>),
  pasteImage: { begin, chunk, commit, abort },
};

// The test environment has no FileReader; this covers the readAsDataURL path.
class FakeFileReader {
  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then(
      (buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
        this.onload?.();
      },
      (err: Error) => {
        this.error = err;
        this.onerror?.();
      },
    );
  }
}
vi.stubGlobal("FileReader", FakeFileReader);

const PANE_ID = "pane-1";
const PATH = "/home/user/.manor/pasted-images/x.png";

function makeBlob(size: number, type = "image/png"): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return new Blob([bytes], { type });
}

function decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

beforeEach(() => {
  vi.clearAllMocks();
  begin.mockResolvedValue({ uploadId: "up-1" });
  chunk.mockResolvedValue(undefined);
  commit.mockResolvedValue({ path: PATH });
  abort.mockResolvedValue(undefined);
});

describe("uploadPastedImage", () => {
  it.each([
    ["one chunk", 1000, [1000]],
    ["exactly two chunks", PASTED_IMAGE_CHUNK_BYTES * 2, [PASTED_IMAGE_CHUNK_BYTES, PASTED_IMAGE_CHUNK_BYTES]],
    [
      "two and a half chunks",
      PASTED_IMAGE_CHUNK_BYTES * 2.5,
      [PASTED_IMAGE_CHUNK_BYTES, PASTED_IMAGE_CHUNK_BYTES, PASTED_IMAGE_CHUNK_BYTES / 2],
    ],
  ])("splits %s at the chunk boundary", async (_name, size, sizes) => {
    await uploadPastedImage(PANE_ID, makeBlob(size));

    expect(begin).toHaveBeenCalledWith(PANE_ID, { mime: "image/png", size });
    expect(chunk).toHaveBeenCalledTimes(sizes.length);
    sizes.forEach((n, i) => {
      expect(chunk.mock.calls[i].slice(0, 3)).toEqual([PANE_ID, "up-1", i]);
      expect(decode(chunk.mock.calls[i][3]).length).toBe(n);
    });
    expect(commit).toHaveBeenCalledWith(PANE_ID, "up-1");
    expect(abort).not.toHaveBeenCalled();
  });

  it("sends chunks that join back to the input", async () => {
    const blob = makeBlob(PASTED_IMAGE_CHUNK_BYTES * 2 + 123);

    await uploadPastedImage(PANE_ID, blob);

    const joined = new Uint8Array(blob.size);
    let off = 0;
    for (const call of chunk.mock.calls) {
      const bytes = decode(call[3]);
      joined.set(bytes, off);
      off += bytes.length;
    }
    expect(off).toBe(blob.size);
    expect(joined).toEqual(new Uint8Array(await blob.arrayBuffer()));
  });

  it("names the host on every call when given one", async () => {
    await uploadPastedImage(PANE_ID, makeBlob(10), { hostId: "cloud" });

    const target = { hostId: "cloud" };
    expect(begin).toHaveBeenCalledWith(PANE_ID, { mime: "image/png", size: 10 }, target);
    expect(chunk.mock.calls[0][4]).toEqual(target);
    expect(commit).toHaveBeenCalledWith(PANE_ID, "up-1", target);
  });

  it("returns the path commit gives back", async () => {
    await expect(uploadPastedImage(PANE_ID, makeBlob(10))).resolves.toBe(PATH);
  });

  it("refuses an unsupported type without calling begin", async () => {
    const err = await uploadPastedImage(PANE_ID, makeBlob(10, "image/bmp")).catch((e) => e);

    expect(err).toBeInstanceOf(PasteImageError);
    expect(err.message).toBe("Only PNG, JPEG, GIF and WebP images can be pasted");
    expect(begin).not.toHaveBeenCalled();
  });

  it("refuses an oversized image without calling begin", async () => {
    const err = await uploadPastedImage(
      PANE_ID,
      makeBlob(MAX_PASTED_IMAGE_BYTES + 1),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(PasteImageError);
    expect(err.message).toContain("16 MiB");
    expect(begin).not.toHaveBeenCalled();
  });

  it("aborts and rethrows when a chunk fails", async () => {
    chunk.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("boom"));

    await expect(
      uploadPastedImage(PANE_ID, makeBlob(PASTED_IMAGE_CHUNK_BYTES * 2)),
    ).rejects.toThrow("boom");

    expect(abort).toHaveBeenCalledWith(PANE_ID, "up-1");
    expect(commit).not.toHaveBeenCalled();
  });

  it("stops between chunks once its signal aborts, and never commits", async () => {
    const controller = new AbortController();
    chunk.mockImplementationOnce(async () => controller.abort());

    await expect(
      uploadPastedImage(PANE_ID, makeBlob(PASTED_IMAGE_CHUNK_BYTES * 2), { signal: controller.signal }),
    ).rejects.toThrow();

    expect(chunk).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(PANE_ID, "up-1");
    expect(commit).not.toHaveBeenCalled();
  });

  it("rethrows the original error even if abort fails", async () => {
    chunk.mockRejectedValue(new Error("boom"));
    abort.mockRejectedValue(new Error("abort failed"));

    await expect(uploadPastedImage(PANE_ID, makeBlob(10))).rejects.toThrow("boom");
  });

  it("reports progress after each chunk", async () => {
    const onProgress = vi.fn();
    const size = PASTED_IMAGE_CHUNK_BYTES * 2.5;

    await uploadPastedImage(PANE_ID, makeBlob(size), { onProgress });

    expect(onProgress.mock.calls).toEqual([
      [PASTED_IMAGE_CHUNK_BYTES, size],
      [PASTED_IMAGE_CHUNK_BYTES * 2, size],
      [size, size],
    ]);
  });
});
