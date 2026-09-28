import { describe, it, expect, vi } from "vitest";
import { uploadClipboardImage, type ClipboardImage } from "../paste-image";

function makeRegistry(opts: {
  ownerOf?: string | undefined;
  homeDir?: () => Promise<string>;
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  exec?: (cmd: string, args: string[]) => Promise<string>;
}) {
  const shell = {
    homeDir: opts.homeDir ?? vi.fn().mockResolvedValue("/home/box"),
    writeFile: opts.writeFile ?? vi.fn().mockResolvedValue(undefined),
    exec: opts.exec ?? vi.fn().mockResolvedValue(""),
  };
  const get = vi.fn().mockReturnValue({ shell });
  const registry = {
    sessions: { ownerOf: vi.fn().mockReturnValue(opts.ownerOf) },
    get,
  };
  return { registry, shell, get };
}

function makeImage(
  opts: { empty?: boolean; bytes?: Buffer } = {},
): ClipboardImage {
  return {
    isEmpty: () => opts.empty ?? false,
    toPNG: () => opts.bytes ?? Buffer.from("png-bytes"),
  };
}

describe("uploadClipboardImage", () => {
  it("returns local when the pane has no remote owner", async () => {
    const { registry, get } = makeRegistry({ ownerOf: undefined });
    const result = await uploadClipboardImage(
      registry as never,
      "pane-a",
      makeImage(),
    );
    expect(result).toEqual({ kind: "local" });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns local when the pane's owner is the local host", async () => {
    const { registry, get } = makeRegistry({ ownerOf: "local" });
    const result = await uploadClipboardImage(
      registry as never,
      "pane-a",
      makeImage(),
    );
    expect(result).toEqual({ kind: "local" });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns none when the clipboard has no image, without touching the host", async () => {
    const { registry, get } = makeRegistry({ ownerOf: "box" });
    const result = await uploadClipboardImage(
      registry as never,
      "pane-a",
      makeImage({ empty: true }),
    );
    expect(result).toEqual({ kind: "none" });
    expect(get).not.toHaveBeenCalled();
  });

  it("uploads to <homeDir>/.manor/pasted-images and sweeps old files", async () => {
    const { registry, shell } = makeRegistry({ ownerOf: "box" });
    const bytes = Buffer.from("some-png-bytes");
    const result = await uploadClipboardImage(
      registry as never,
      "pane-a",
      makeImage({ bytes }),
    );

    expect(result.kind).toBe("uploaded");
    const uploaded = result as { kind: "uploaded"; path: string };
    expect(uploaded.path).toMatch(
      /^\/home\/box\/\.manor\/pasted-images\/\d{8}-\d{6}-[0-9a-f]{8}\.png$/,
    );
    expect(shell.writeFile).toHaveBeenCalledWith(uploaded.path, bytes);
    expect(shell.exec).toHaveBeenCalledWith("find", [
      "/home/box/.manor/pasted-images",
      "-type",
      "f",
      "-mtime",
      "+7",
      "-delete",
    ]);
  });

  it("does not fail the upload when the sweep itself fails", async () => {
    const { registry } = makeRegistry({
      ownerOf: "box",
      exec: vi.fn().mockRejectedValue(new Error("no find on box")),
    });
    const result = await uploadClipboardImage(
      registry as never,
      "pane-a",
      makeImage(),
    );
    expect(result.kind).toBe("uploaded");
  });

  it("returns error when the write fails, e.g. the host is unavailable", async () => {
    const { registry } = makeRegistry({
      ownerOf: "box",
      writeFile: vi
        .fn()
        .mockRejectedValue(new Error("host box is not connected")),
    });
    const result = await uploadClipboardImage(
      registry as never,
      "pane-a",
      makeImage(),
    );
    expect(result).toEqual({
      kind: "error",
      message: "host box is not connected",
    });
  });
});
