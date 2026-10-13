import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeFileAtomicAsync } from "./fs-atomic";

describe("writeFileAtomicAsync", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-fs-atomic-"));
    file = path.join(dir, "nested", "state.enc");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory and writes the file with the mode", async () => {
    await writeFileAtomicAsync(file, "hello", { mode: 0o600 });
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("restates the mode on an existing file", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old", { mode: 0o644 });
    await writeFileAtomicAsync(file, "new", { mode: 0o600 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves the old file intact, and no temp file, when the rename never happens", async () => {
    await writeFileAtomicAsync(file, "old");
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("killed"));
    await expect(writeFileAtomicAsync(file, "new")).rejects.toThrow("killed");
    expect(fs.readFileSync(file, "utf8")).toBe("old");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["state.enc"]);
  });

  it("lands the later of two racing writes whole", async () => {
    await Promise.all([
      writeFileAtomicAsync(file, "a".repeat(100_000)),
      writeFileAtomicAsync(file, "b".repeat(100_000)),
    ]);
    const text = fs.readFileSync(file, "utf8");
    expect(text === "a".repeat(100_000) || text === "b".repeat(100_000)).toBe(true);
  });
});
