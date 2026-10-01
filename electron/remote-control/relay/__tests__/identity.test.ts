import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => ({ available: true }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => {
      const text = b.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
      return text.slice(4);
    },
  },
}));

import { base64urlDecode, roomIdFor } from "../../../../src/lib/relay-crypto";
import { EncryptionUnavailableError } from "../../devices";
import { RelayIdentityStore, wipe } from "../identity";

describe("RelayIdentityStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    keychain.available = true;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-relay-id-"));
    file = path.join(dir, "remote-relay-identity.enc");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates on first use and reads the same identity back", () => {
    const first = new RelayIdentityStore(file);
    const created = first.load();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^enc:/);

    const second = new RelayIdentityStore(file);
    const loaded = second.load();
    expect(loaded.ed25519.priv).toEqual(created.ed25519.priv);
    expect(loaded.x25519.priv).toEqual(created.x25519.priv);
    expect(second.roomId).toBe(roomIdFor(created.ed25519.pub));
    expect(base64urlDecode(second.x25519Pub)).toEqual(created.x25519.pub);
  });

  it("exposes public info without handing out keys", () => {
    const store = new RelayIdentityStore(file);
    const info = store.describe();
    expect(info.roomId).toHaveLength(22);
    expect(store.roomId).toBe(info.roomId);
    expect(store.x25519Pub).toBe(info.x25519Pub);
  });

  it("refuses to store anything without OS encryption", () => {
    keychain.available = false;
    const store = new RelayIdentityStore(file);
    expect(() => store.load()).toThrow(EncryptionUnavailableError);
    expect(() => store.reset()).toThrow(EncryptionUnavailableError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reset() regenerates both keys and the room", () => {
    const store = new RelayIdentityStore(file);
    const before = store.describe();
    const after = store.reset();
    expect(after.roomId).not.toBe(before.roomId);
    expect(after.x25519Pub).not.toBe(before.x25519Pub);
    expect(new RelayIdentityStore(file).roomId).toBe(after.roomId);
  });

  it("replaces a file it cannot decrypt", () => {
    fs.writeFileSync(file, "garbage");
    const store = new RelayIdentityStore(file);
    expect(store.roomId).toHaveLength(22);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^enc:/);
  });

  it("wipe() zeroes the private keys of a loaded copy only", () => {
    const store = new RelayIdentityStore(file);
    const copy = store.load();
    wipe(copy);
    expect(copy.ed25519.priv.every((b) => b === 0)).toBe(true);
    expect(store.load().ed25519.priv.some((b) => b !== 0)).toBe(true);
  });
});
