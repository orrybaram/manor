import { describe, it, expect, vi } from "vitest";
import { writePastedImage } from "../pasted-images";

function makeRegistry(
  opts: {
    writeFile?: (path: string, data: Buffer) => Promise<void>;
    exec?: (cmd: string, args: string[]) => Promise<string>;
  } = {},
) {
  const shell = {
    homeDir: vi.fn().mockResolvedValue("/home/box"),
    writeFile: opts.writeFile ?? vi.fn().mockResolvedValue(undefined),
    exec: opts.exec ?? vi.fn().mockResolvedValue(""),
  };
  const get = vi.fn().mockReturnValue({ shell });
  return { registry: { get }, shell, get };
}

describe("writePastedImage", () => {
  it.each(["png", "jpg", "gif", "webp"])(
    "names the file with the .%s extension",
    async (ext) => {
      const { registry, get } = makeRegistry();
      const filePath = await writePastedImage(
        registry as never,
        "box",
        Buffer.from("x"),
        ext,
      );
      expect(get).toHaveBeenCalledWith("box");
      expect(filePath).toMatch(
        new RegExp(
          `^/home/box/\\.manor/pasted-images/\\d{8}-\\d{6}-[0-9a-f]{8}\\.${ext}$`,
        ),
      );
    },
  );

  it("writes the bytes to the returned path", async () => {
    const { registry, shell } = makeRegistry();
    const bytes = Buffer.from("some-bytes");
    const filePath = await writePastedImage(
      registry as never,
      "box",
      bytes,
      "png",
    );
    expect(shell.writeFile).toHaveBeenCalledWith(filePath, bytes);
  });

  it("sweeps files older than a week", async () => {
    const { registry, shell } = makeRegistry();
    await writePastedImage(registry as never, "box", Buffer.from("x"), "png");
    expect(shell.exec).toHaveBeenCalledWith("find", [
      "/home/box/.manor/pasted-images",
      "-type",
      "f",
      "-mtime",
      "+7",
      "-delete",
    ]);
  });

  it("ignores a sweep failure", async () => {
    const { registry } = makeRegistry({
      exec: vi.fn().mockRejectedValue(new Error("no find on box")),
    });
    await expect(
      writePastedImage(registry as never, "box", Buffer.from("x"), "png"),
    ).resolves.toMatch(/\.png$/);
  });

  it("rethrows a write failure", async () => {
    const { registry } = makeRegistry({
      writeFile: vi.fn().mockRejectedValue(new Error("host box is away")),
    });
    await expect(
      writePastedImage(registry as never, "box", Buffer.from("x"), "png"),
    ).rejects.toThrow("host box is away");
  });
});
