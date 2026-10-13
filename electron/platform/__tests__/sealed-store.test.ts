/**
 * The sealed store is where pairings used to get lost (ADR-226 B1–B3): a
 * torn write that read as corrupt, a failed write nobody heard about, and a
 * flaky secret helper that read as a missing file. Each has a test here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EncryptionUnavailableError,
  readSealed,
  SealedStore,
  type SealedCodec,
} from "../sealed-store";
import {
  plainFileSecretBox,
  SecretBoxUnavailableError,
  type SecretBox,
} from "../secret-box";

interface State {
  n: number;
}

const codec: SealedCodec<State> = {
  parse(text) {
    const parsed = JSON.parse(text) as Partial<State>;
    return typeof parsed.n === "number" ? { n: parsed.n } : null;
  },
  serialize: (v) => JSON.stringify(v),
};

describe("SealedStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-sealed-store-"));
    file = path.join(dir, "nested", "state.enc");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = (box: SecretBox = plainFileSecretBox) =>
    new SealedStore(box, file, "test state", codec);

  it("reads nothing from a missing file", async () => {
    expect(await open().init()).toBeNull();
    expect(await readSealed(plainFileSecretBox, file)).toBeNull();
  });

  it("writes in order, 0600, and reads the last value back", async () => {
    const store = open();
    store.write({ n: 1 });
    store.write({ n: 2 });
    await store.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await open().init()).toEqual({ n: 2 });
  });

  it("starts fresh from a torn or garbage file", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"n":');
    expect(await open().init()).toBeNull();
    fs.writeFileSync(file, '{"other":1}');
    expect(await open().init()).toBeNull();
  });

  it("starts fresh from a file the box cannot open", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "sealed by someone else");
    const box: SecretBox = {
      ...plainFileSecretBox,
      decrypt: async () => {
        throw new Error("bad tag");
      },
    };
    expect(await open(box).init()).toBeNull();
  });

  it("rethrows a box that could not run, and leaves the file alone", async () => {
    const store = open();
    store.write({ n: 7 });
    await store.flush();
    const box: SecretBox = {
      ...plainFileSecretBox,
      decrypt: async () => {
        throw new SecretBoxUnavailableError("timed out");
      },
    };
    await expect(open(box).init()).rejects.toThrow(SecretBoxUnavailableError);
    expect(fs.readFileSync(file, "utf8")).toBe('{"n":7}');
  });

  it("rethrows a read error other than a missing file", async () => {
    fs.mkdirSync(file, { recursive: true });
    await expect(open().init()).rejects.toThrow();
  });

  it("refuses to write when the box cannot store", async () => {
    const store = open({ ...plainFileSecretBox, available: () => false });
    expect(() => store.write({ n: 1 })).toThrow(EncryptionUnavailableError);
    await store.flush();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reports a failed write: flush rejects, and every later write throws it", async () => {
    let fail = true;
    const store = open({
      ...plainFileSecretBox,
      encrypt: async (b) => {
        if (fail) throw new Error("disk full");
        return Buffer.from(b);
      },
    });
    store.write({ n: 1 });
    // Queued behind the failure: not attempted, so the reported failure stays
    // the first one.
    store.write({ n: 2 });
    await expect(store.flush()).rejects.toThrow("disk full");
    fail = false;
    expect(() => store.write({ n: 3 })).toThrow("disk full");
    await expect(store.flush()).rejects.toThrow("disk full");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps the old file whole when a write dies before its rename", async () => {
    const store = open();
    store.write({ n: 1 });
    await store.flush();
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("killed"));
    store.write({ n: 2 });
    await expect(store.flush()).rejects.toThrow("killed");
    expect(await open().init()).toEqual({ n: 1 });
  });
});
