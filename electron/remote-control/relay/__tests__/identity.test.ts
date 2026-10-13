import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { base64urlDecode, roomIdFor } from "../../../../src/lib/relay-crypto";
import { EncryptionUnavailableError } from "../../../platform/sealed-store";
import { switchableBox } from "../../../platform/__tests__/switchable-box";
import { SecretBoxUnavailableError } from "../../../platform/secret-box";
import { RelayIdentityStore } from "../identity";
import { wipe } from "../wipe";

describe("RelayIdentityStore", () => {
  const keychain = switchableBox();
  /** A store over the file, initialised the way the app does it. */
  const open = async () => {
    const store = new RelayIdentityStore(keychain, file);
    await store.init();
    await store.flush();
    return store;
  };
  let dir: string;
  let file: string;

  beforeEach(() => {
    keychain.setAvailable(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-relay-id-"));
    file = path.join(dir, "remote-relay-identity.enc");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates on first use and reads the same identity back", async () => {
    const first = await open();
    const created = first.load();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The plaintext box stores JSON as is.
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveProperty("v", 1);

    const second = await open();
    const loaded = second.load();
    expect(loaded.ed25519.priv).toEqual(created.ed25519.priv);
    expect(loaded.x25519.priv).toEqual(created.x25519.priv);
    expect(second.roomId).toBe(roomIdFor(created.ed25519.pub));
    expect(base64urlDecode(second.x25519Pub)).toEqual(created.x25519.pub);
  });

  it("exposes public info without handing out keys", async () => {
    const store = await open();
    const info = store.describe();
    expect(info.roomId).toHaveLength(22);
    expect(store.roomId).toBe(info.roomId);
    expect(store.x25519Pub).toBe(info.x25519Pub);
  });

  it("refuses to store anything without OS encryption", async () => {
    keychain.setAvailable(false);
    const store = await open();
    expect(() => store.load()).toThrow(EncryptionUnavailableError);
    await expect(store.reset()).rejects.toThrow(EncryptionUnavailableError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reset() regenerates both keys and the room", async () => {
    const store = await open();
    const before = store.describe();
    const after = await store.reset();
    expect(after.roomId).not.toBe(before.roomId);
    expect(after.x25519Pub).not.toBe(before.x25519Pub);
    expect((await open()).roomId).toBe(after.roomId);
  });

  it("replaces a file it cannot parse", async () => {
    fs.writeFileSync(file, "garbage");
    const store = await open();
    expect(store.roomId).toHaveLength(22);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveProperty("v", 1);
  });

  it("leaves the file alone when the secret box could not run", async () => {
    const created = (await open()).describe();
    const before = fs.readFileSync(file, "utf8");
    const store = new RelayIdentityStore(
      {
        ...keychain,
        decrypt: async () => {
          throw new SecretBoxUnavailableError("helper timed out");
        },
      },
      file,
    );
    await expect(store.init()).rejects.toThrow(SecretBoxUnavailableError);
    expect(() => store.describe()).toThrow(/init/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    // A later init that can read gets the same identity back.
    expect((await open()).roomId).toBe(created.roomId);
  });

  it("reads the file even while the box cannot store, and serves it once it can", async () => {
    const created = (await open()).describe();
    keychain.setAvailable(false);
    const store = await open();
    expect(() => store.describe()).toThrow(EncryptionUnavailableError);
    keychain.setAvailable(true);
    expect(store.describe()).toEqual(created);
  });

  it("must be initialised before use", () => {
    const store = new RelayIdentityStore(keychain, file);
    expect(() => store.load()).toThrow(/init/);
  });

  it("wipe() zeroes the private keys of a loaded copy only", async () => {
    const store = await open();
    const copy = store.load();
    wipe(copy);
    expect(copy.ed25519.priv.every((b) => b === 0)).toBe(true);
    expect(store.load().ed25519.priv.some((b) => b !== 0)).toBe(true);
  });
});
