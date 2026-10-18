import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCtx } from "../../method";
import {
  MAX_PASTED_IMAGE_BYTES,
  PASTED_IMAGE_CHUNK_BYTES,
} from "../../../../src/lib/pasted-image";
import {
  _resetPasteImageUploadsForTests,
  _stagedUploadCountForTests,
  MAX_UPLOADS_PER_CALLER,
  UPLOAD_IDLE_MS,
  pasteImageAbort,
  pasteImageBegin,
  pasteImageChunk,
  pasteImageCommit,
  type PasteImageDeps,
} from "../paste-image";

function setup(hostOf: (paneId: string) => string | undefined = () => "box") {
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const shell = {
    homeDir: vi.fn().mockResolvedValue("/home/me"),
    writeFile,
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
  };
  const get = vi.fn(() => ({ shell }));
  const deps = {
    backendRegistry: { get },
    getPaneHostId: vi.fn(hostOf),
  } as unknown as PasteImageDeps;
  return { deps, get, writeFile, ctx: localCtx(deps), other: localCtx(deps, "other") };
}

const b64 = (bytes: Buffer) => bytes.toString("base64");

beforeEach(() => {
  _resetPasteImageUploadsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  _resetPasteImageUploadsForTests();
});

describe("pasteImage: the happy path", () => {
  it("writes three chunks, joined, to the pane's host with the type's extension", async () => {
    const { ctx, get, writeFile } = setup();
    const parts = [Buffer.from("aaa"), Buffer.from("bbbb"), Buffer.from("cc")];
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/jpeg", size: 9 });
    parts.forEach((part, i) => pasteImageChunk(ctx, "p1", uploadId, i, b64(part)));

    const { path } = await pasteImageCommit(ctx, "p1", uploadId);

    expect(get).toHaveBeenCalledWith("box");
    expect(path).toMatch(/^\/home\/me\/\.manor\/pasted-images\/\d{8}-\d{6}-[0-9a-f]{8}\.jpg$/);
    expect(writeFile).toHaveBeenCalledWith(path, Buffer.from("aaabbbbcc"));
    expect(_stagedUploadCountForTests()).toBe(0);
  });

  it("writes to the local host when the pane's host is unknown", async () => {
    const { ctx, get } = setup(() => undefined);
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 2 });
    pasteImageChunk(ctx, "p1", uploadId, 0, b64(Buffer.from("hi")));

    const { path } = await pasteImageCommit(ctx, "p1", uploadId);

    expect(get).toHaveBeenCalledWith("local");
    expect(path).toMatch(/\.png$/);
  });

  it("hands out 128-bit ids", () => {
    const { ctx } = setup();
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 1 });
    expect(uploadId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("pasteImage: refusals", () => {
  it("refuses a type that is not an accepted image", () => {
    const { ctx } = setup();
    expect(() =>
      pasteImageBegin(ctx, "p1", { mime: "image/svg+xml", size: 10 }),
    ).toThrow(/Unsupported image type/);
    expect(() =>
      pasteImageBegin(ctx, "p1", { mime: "toString", size: 10 }),
    ).toThrow(/Unsupported image type/);
    expect(_stagedUploadCountForTests()).toBe(0);
  });

  it("refuses a size over the cap, zero, or not an integer", () => {
    const { ctx } = setup();
    expect(() =>
      pasteImageBegin(ctx, "p1", { mime: "image/png", size: MAX_PASTED_IMAGE_BYTES + 1 }),
    ).toThrow(/too large/);
    expect(() => pasteImageBegin(ctx, "p1", { mime: "image/png", size: 0 })).toThrow();
    expect(() => pasteImageBegin(ctx, "p1", { mime: "image/png", size: 1.5 })).toThrow();
    expect(() => pasteImageBegin(ctx, "p1", null as never)).toThrow();
    expect(_stagedUploadCountForTests()).toBe(0);
  });

  it("refuses a chunk out of order and drops the upload", () => {
    const { ctx } = setup();
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 4 });
    expect(() => pasteImageChunk(ctx, "p1", uploadId, 1, b64(Buffer.from("ab")))).toThrow(
      /out of order/,
    );
    expect(_stagedUploadCountForTests()).toBe(0);
    expect(() => pasteImageChunk(ctx, "p1", uploadId, 0, b64(Buffer.from("ab")))).toThrow(
      "Unknown upload",
    );
  });

  it("refuses a chunk past the declared size", () => {
    const { ctx } = setup();
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 3 });
    pasteImageChunk(ctx, "p1", uploadId, 0, b64(Buffer.from("ab")));
    expect(() => pasteImageChunk(ctx, "p1", uploadId, 1, b64(Buffer.from("cd")))).toThrow(
      /larger than declared/,
    );
    expect(_stagedUploadCountForTests()).toBe(0);
  });

  it("refuses an oversized base64 string before decoding it", () => {
    const { ctx } = setup();
    const { uploadId } = pasteImageBegin(ctx, "p1", {
      mime: "image/png",
      size: MAX_PASTED_IMAGE_BYTES,
    });
    const from = vi.spyOn(Buffer, "from");
    const tooLong = "A".repeat(4 * Math.ceil(PASTED_IMAGE_CHUNK_BYTES / 3) + 8);
    expect(() => pasteImageChunk(ctx, "p1", uploadId, 0, tooLong)).toThrow(/too large/);
    expect(from).not.toHaveBeenCalledWith(tooLong, "base64");
    from.mockRestore();
  });

  it("accepts a full chunk", () => {
    const { ctx } = setup();
    const { uploadId } = pasteImageBegin(ctx, "p1", {
      mime: "image/png",
      size: PASTED_IMAGE_CHUNK_BYTES,
    });
    expect(() =>
      pasteImageChunk(ctx, "p1", uploadId, 0, b64(Buffer.alloc(PASTED_IMAGE_CHUNK_BYTES, 7))),
    ).not.toThrow();
  });

  it("refuses a commit with bytes missing, and drops the upload", async () => {
    const { ctx, writeFile } = setup();
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 5 });
    pasteImageChunk(ctx, "p1", uploadId, 0, b64(Buffer.from("abc")));
    await expect(pasteImageCommit(ctx, "p1", uploadId)).rejects.toThrow(/incomplete/);
    expect(writeFile).not.toHaveBeenCalled();
    expect(_stagedUploadCountForTests()).toBe(0);
  });

  it("refuses an unknown upload id", async () => {
    const { ctx } = setup();
    expect(() => pasteImageChunk(ctx, "p1", "nope", 0, "")).toThrow("Unknown upload");
    await expect(pasteImageCommit(ctx, "p1", "nope")).rejects.toThrow("Unknown upload");
  });

  it("refuses another caller's upload id, or another pane's, and leaves it staged", async () => {
    const { ctx, other } = setup();
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 2 });
    expect(() => pasteImageChunk(other, "p1", uploadId, 0, b64(Buffer.from("hi")))).toThrow(
      "Unknown upload",
    );
    await expect(pasteImageCommit(other, "p1", uploadId)).rejects.toThrow("Unknown upload");
    expect(() => pasteImageChunk(ctx, "p2", uploadId, 0, b64(Buffer.from("hi")))).toThrow(
      "Unknown upload",
    );
    pasteImageAbort(other, "p1", uploadId);
    expect(_stagedUploadCountForTests()).toBe(1);

    pasteImageChunk(ctx, "p1", uploadId, 0, b64(Buffer.from("hi")));
    await expect(pasteImageCommit(ctx, "p1", uploadId)).resolves.toHaveProperty("path");
  });
});

describe("pasteImage: lifecycle", () => {
  it("abort drops the staging, and never throws", () => {
    const { ctx } = setup();
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 2 });
    pasteImageAbort(ctx, "p1", uploadId);
    expect(_stagedUploadCountForTests()).toBe(0);
    expect(() => pasteImageAbort(ctx, "p1", uploadId)).not.toThrow();
    expect(() => pasteImageAbort(ctx, 3 as never, null as never)).not.toThrow();
  });

  it("limits how many uploads one caller holds", () => {
    const { ctx, other } = setup();
    for (let i = 0; i < MAX_UPLOADS_PER_CALLER; i++) {
      pasteImageBegin(ctx, "p1", { mime: "image/png", size: 1 });
    }
    expect(() => pasteImageBegin(ctx, "p1", { mime: "image/png", size: 1 })).toThrow(
      "Too many uploads in progress",
    );
    // Another caller has its own allowance.
    expect(() => pasteImageBegin(other, "p1", { mime: "image/png", size: 1 })).not.toThrow();
  });

  it("limits the bytes staged across every caller", () => {
    const { deps } = setup();
    // 8 callers × 16 MiB is the 128 MiB total.
    for (let i = 0; i < 8; i++) {
      pasteImageBegin(localCtx(deps, `c${i}`), "p1", {
        mime: "image/png",
        size: MAX_PASTED_IMAGE_BYTES,
      });
    }
    expect(() =>
      pasteImageBegin(localCtx(deps, "c9"), "p1", { mime: "image/png", size: 1 }),
    ).toThrow("Too many uploads in progress");
  });

  it("sweeps an upload left idle", () => {
    vi.useFakeTimers();
    const { ctx } = setup();
    const idle = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 4 });
    const busy = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 4 });

    vi.advanceTimersByTime(UPLOAD_IDLE_MS - 15_000);
    pasteImageChunk(ctx, "p1", busy.uploadId, 0, b64(Buffer.from("a")));
    vi.advanceTimersByTime(30_000);

    expect(() => pasteImageChunk(ctx, "p1", idle.uploadId, 0, b64(Buffer.from("a")))).toThrow(
      "Unknown upload",
    );
    expect(_stagedUploadCountForTests()).toBe(1);

    vi.advanceTimersByTime(UPLOAD_IDLE_MS);
    expect(_stagedUploadCountForTests()).toBe(0);
    // The sweep stops with the map empty.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the staging and rethrows when the write fails", async () => {
    const { ctx, writeFile } = setup();
    writeFile.mockRejectedValueOnce(new Error("disk full"));
    const { uploadId } = pasteImageBegin(ctx, "p1", { mime: "image/png", size: 2 });
    pasteImageChunk(ctx, "p1", uploadId, 0, b64(Buffer.from("hi")));

    await expect(pasteImageCommit(ctx, "p1", uploadId)).rejects.toThrow("disk full");
    expect(_stagedUploadCountForTests()).toBe(0);
  });
});
