import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import crypto from "node:crypto";

import {
  keyFileSecretBox,
  libsecretSecretBox,
  pickHostSecretBox,
  plainFileSecretBox,
  secretKeyOnVolume,
  SecretBoxUnavailableError,
  systemdCredsSecretBox,
  type ExecFn,
  type SecretBox,
} from "../secret-box";

const fakeBox = (name: "systemd-creds" | "libsecret"): SecretBox => ({
  available: () => true,
  backend: () => name,
  encrypt: async (b) => b,
  decrypt: async (b) => b,
});

/** A fake `systemd-creds` that "encrypts" by reversing the bytes. */
function fakeSystemdCreds(version = "systemd 257 (257.1)"): ExecFn {
  return async (cmd, args, input) => {
    if (cmd !== "systemd-creds") return { code: null, stdout: Buffer.alloc(0) };
    if (args[0] === "--version") {
      return { code: 0, stdout: Buffer.from(`${version}\n+PAM`) };
    }
    // Secrets only ever travel on stdin/stdout.
    expect(args.join(" ")).not.toContain("secret");
    return { code: 0, stdout: Buffer.from(input!).reverse() };
  };
}

/** An in-memory `secret-tool`. */
function fakeSecretTool(): { exec: ExecFn; store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  const exec: ExecFn = async (cmd, args, input) => {
    if (cmd !== "secret-tool") return { code: null, stdout: Buffer.alloc(0) };
    const verb = args[0];
    const attrs = args.filter((a) => !a.startsWith("--")).slice(1).join("|");
    if (verb === "store") {
      store.set(attrs, Buffer.from(input!));
      return { code: 0, stdout: Buffer.alloc(0) };
    }
    if (verb === "lookup") {
      const v = store.get(attrs);
      return v ? { code: 0, stdout: v } : { code: 1, stdout: Buffer.alloc(0) };
    }
    store.delete(attrs);
    return { code: 0, stdout: Buffer.alloc(0) };
  };
  return { exec, store };
}

describe("plainFileSecretBox", () => {
  it("is the identity", async () => {
    const data = Buffer.from("hello");
    expect(await plainFileSecretBox.encrypt(data)).toEqual(data);
    expect(await plainFileSecretBox.decrypt(data)).toEqual(data);
    expect(plainFileSecretBox.available()).toBe(true);
    expect(plainFileSecretBox.backend()).toBe("plaintext");
  });
});

describe("systemdCredsSecretBox", () => {
  it("round-trips through the helper", async () => {
    const box = await systemdCredsSecretBox(fakeSystemdCreds());
    expect(box?.backend()).toBe("systemd-creds");
    const sealed = await box!.encrypt(Buffer.from("abc"));
    expect(sealed.toString()).toBe("cba");
    expect((await box!.decrypt(sealed)).toString()).toBe("abc");
  });

  it("is unavailable before v256", async () => {
    expect(
      await systemdCredsSecretBox(fakeSystemdCreds("systemd 255 (255.4)")),
    ).toBeNull();
  });

  it("is unavailable without the binary", async () => {
    expect(
      await systemdCredsSecretBox(async () => ({
        code: null,
        stdout: Buffer.alloc(0),
      })),
    ).toBeNull();
  });

  it("tells a helper that could not run apart from a failed decrypt", async () => {
    let helper: "ok" | "fails" | "cannot-run" = "ok";
    const exec: ExecFn = async (cmd, args, input) => {
      if (args[0] === "--version") {
        return { code: 0, stdout: Buffer.from("systemd 257") };
      }
      if (helper === "cannot-run") return { code: null, stdout: Buffer.alloc(0) };
      if (helper === "fails") return { code: 1, stdout: Buffer.alloc(0) };
      return fakeSystemdCreds()(cmd, args, input);
    };
    const box = (await systemdCredsSecretBox(exec))!;
    helper = "cannot-run";
    await expect(box.decrypt(Buffer.from("x"))).rejects.toBeInstanceOf(
      SecretBoxUnavailableError,
    );
    helper = "fails";
    const failed = await box.decrypt(Buffer.from("x")).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(SecretBoxUnavailableError);
  });

  it("is unavailable when the round trip does not match", async () => {
    const exec: ExecFn = async (_cmd, args, input) =>
      args[0] === "--version"
        ? { code: 0, stdout: Buffer.from("systemd 257") }
        : { code: 0, stdout: Buffer.from(input!) .subarray(1) };
    expect(await systemdCredsSecretBox(exec)).toBeNull();
  });
});

describe("libsecretSecretBox", () => {
  const env = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" };

  it("needs a session bus", async () => {
    expect(await libsecretSecretBox(fakeSecretTool().exec, {})).toBeNull();
  });

  it("seals with AES-GCM under a keyring-held data key, and reuses it", async () => {
    const tool = fakeSecretTool();
    const box = await libsecretSecretBox(tool.exec, env);
    expect(box?.backend()).toBe("libsecret");
    const sealed = await box!.encrypt(Buffer.from("top secret"));
    expect(sealed.toString()).not.toContain("top secret");
    expect((await box!.decrypt(sealed)).toString()).toBe("top secret");

    const again = await libsecretSecretBox(tool.exec, env);
    expect((await again!.decrypt(sealed)).toString()).toBe("top secret");

    sealed[sealed.length - 1] ^= 1;
    await expect(box!.decrypt(sealed)).rejects.toThrow();
  });

  it("is unavailable when the keyring does not store", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: Buffer.alloc(0) });
    expect(await libsecretSecretBox(exec, env)).toBeNull();
  });
});

describe("keyFileSecretBox", () => {
  let dir: string;
  const key = crypto.randomBytes(32);
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-key-file-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is absent without a key", () => {
    expect(keyFileSecretBox({})).toBeNull();
  });

  it("round-trips with a base64 key from the environment", async () => {
    const box = keyFileSecretBox({ MANOR_SECRET_KEY: key.toString("base64") })!;
    expect(box.backend()).toBe("key-file");
    const sealed = await box.encrypt(Buffer.from("secret"));
    expect(sealed.subarray(0, 4).toString()).toBe("MKF1");
    expect(sealed.includes("secret")).toBe(false);
    expect((await box.decrypt(sealed)).toString()).toBe("secret");
    // A fresh nonce every time.
    expect((await box.encrypt(Buffer.from("secret"))).equals(sealed)).toBe(false);
  });

  it("reads a raw 32-byte file and a base64 text file", async () => {
    const raw = path.join(dir, "raw");
    const text = path.join(dir, "text");
    fs.writeFileSync(raw, key);
    fs.writeFileSync(text, `  ${key.toString("base64")}\n`);
    const a = keyFileSecretBox({ MANOR_SECRET_KEY_FILE: raw })!;
    const b = keyFileSecretBox({ MANOR_SECRET_KEY_FILE: text })!;
    const sealed = await a.encrypt(Buffer.from("x"));
    expect((await b.decrypt(sealed)).toString()).toBe("x");
  });

  it("fails to open with the wrong key, or without the header", async () => {
    const box = keyFileSecretBox({ MANOR_SECRET_KEY: key.toString("base64") })!;
    const other = keyFileSecretBox({
      MANOR_SECRET_KEY: crypto.randomBytes(32).toString("base64"),
    })!;
    const sealed = await box.encrypt(Buffer.from("secret"));
    await expect(other.decrypt(sealed)).rejects.toThrow();
    await expect(box.decrypt(Buffer.from("not sealed at all, no header here...")))
      .rejects.toThrow("not key-file sealed");
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    await expect(box.decrypt(tampered)).rejects.toThrow();
  });

  it("explains a key of the wrong size or a missing file", () => {
    expect(() => keyFileSecretBox({ MANOR_SECRET_KEY: "c2hvcnQ=" })).toThrow(
      /MANOR_SECRET_KEY must be 32 bytes/,
    );
    expect(() =>
      keyFileSecretBox({ MANOR_SECRET_KEY_FILE: path.join(dir, "missing") }),
    ).toThrow(/could not be read/);
  });

  it("knows a key file kept under ~/.manor", () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".manor", "remote"), { recursive: true });
    const inside = path.join(home, ".manor", "remote", "key");
    const outside = path.join(dir, "mounted-key");
    fs.writeFileSync(inside, key);
    fs.writeFileSync(outside, key);
    const link = path.join(home, ".manor", "link");
    fs.symlinkSync(outside, link);
    expect(secretKeyOnVolume({ MANOR_SECRET_KEY_FILE: inside }, home)).toBe(true);
    expect(secretKeyOnVolume({ MANOR_SECRET_KEY_FILE: outside }, home)).toBe(false);
    // Resolved through the link: it lives outside.
    expect(secretKeyOnVolume({ MANOR_SECRET_KEY_FILE: link }, home)).toBe(false);
    expect(secretKeyOnVolume({ MANOR_SECRET_KEY: "x" }, home)).toBe(false);
    expect(secretKeyOnVolume({}, home)).toBe(false);
  });
});

describe("pickHostSecretBox", () => {
  let dir: string;
  let choiceFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-secret-box-"));
    choiceFile = path.join(dir, "nested", "secret-backend.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const choice = () =>
    (JSON.parse(fs.readFileSync(choiceFile, "utf8")) as { backend: string })
      .backend;

  describe("key-file", () => {
    const env = { MANOR_SECRET_KEY: crypto.randomBytes(32).toString("base64") };
    const systemd = () => async () => fakeBox("systemd-creds");

    it("goes first whenever a key is set, and is remembered", async () => {
      const systemdProbe = vi.fn(systemd());
      const box = await pickHostSecretBox({
        choiceFile,
        env,
        probes: { "systemd-creds": systemdProbe },
      });
      expect(box.backend()).toBe("key-file");
      expect(choice()).toBe("key-file");
      expect(systemdProbe).not.toHaveBeenCalled();
    });

    it("is skipped when no key is set", async () => {
      const box = await pickHostSecretBox({
        choiceFile,
        env: {},
        probes: { "systemd-creds": systemd() },
      });
      expect(box.backend()).toBe("systemd-creds");
    });

    it("throws, never falling back, when sealed with a key that is now unset", async () => {
      await pickHostSecretBox({ choiceFile, env });
      await expect(
        pickHostSecretBox({
          choiceFile,
          env: {},
          probes: { "systemd-creds": systemd() },
        }),
      ).rejects.toThrow(
        new SecretBoxUnavailableError(
          "Pairing keys were sealed with MANOR_SECRET_KEY, which is not set",
        ),
      );
      expect(choice()).toBe("key-file");
    });

    it("upgrades a plaintext host and re-seals its files", async () => {
      await pickHostSecretBox({
        choiceFile,
        env: {},
        probes: { "systemd-creds": async () => null, libsecret: async () => null },
      });
      const file = path.join(path.dirname(choiceFile), "relay-identity.enc");
      fs.writeFileSync(file, '{"v":1}');
      const box = await pickHostSecretBox({ choiceFile, env });
      expect(box.backend()).toBe("key-file");
      expect(choice()).toBe("key-file");
      expect(fs.readFileSync(file).subarray(0, 4).toString()).toBe("MKF1");
      expect((await box.decrypt(fs.readFileSync(file))).toString()).toBe('{"v":1}');
    });
  });

  it("prefers systemd-creds", async () => {
    const box = await pickHostSecretBox({
      choiceFile,
      probes: {
        "systemd-creds": async () => fakeBox("systemd-creds"),
        libsecret: async () => fakeBox("libsecret"),
      },
    });
    expect(box.backend()).toBe("systemd-creds");
    expect(choice()).toBe("systemd-creds");
  });

  it("falls back to libsecret, then plaintext", async () => {
    const viaLibsecret = await pickHostSecretBox({
      choiceFile,
      probes: {
        "systemd-creds": async () => null,
        libsecret: async () => fakeBox("libsecret"),
      },
    });
    expect(viaLibsecret.backend()).toBe("libsecret");

    fs.rmSync(choiceFile);
    const plain = await pickHostSecretBox({
      choiceFile,
      probes: { "systemd-creds": async () => null, libsecret: async () => null },
    });
    expect(plain.backend()).toBe("plaintext");
    expect(choice()).toBe("plaintext");
  });

  it("keeps using the persisted choice", async () => {
    const libsecret = vi.fn(async () => fakeBox("libsecret"));
    await pickHostSecretBox({
      choiceFile,
      probes: { "systemd-creds": async () => null, libsecret },
    });
    // systemd-creds appearing later must not change where keys were sealed.
    const systemd = vi.fn(async () => fakeBox("systemd-creds"));
    const box = await pickHostSecretBox({
      choiceFile,
      probes: { "systemd-creds": systemd, libsecret },
    });
    expect(box.backend()).toBe("libsecret");
    expect(systemd).not.toHaveBeenCalled();
  });

  it("errors, rather than writing plaintext, when the chosen backend is gone", async () => {
    await pickHostSecretBox({
      choiceFile,
      probes: { "systemd-creds": async () => fakeBox("systemd-creds") },
    });
    await expect(
      pickHostSecretBox({
        choiceFile,
        probes: { "systemd-creds": async () => null },
      }),
    ).rejects.toThrow(
      new SecretBoxUnavailableError(
        "Pairing keys were encrypted with systemd-creds, which is no longer available",
      ),
    );
    expect(choice()).toBe("systemd-creds");
  });

  describe("upgrading from plaintext", () => {
    /** "Seals" by prefixing, and refuses to open anything without the prefix. */
    const sealingBox = (name: "systemd-creds" | "libsecret"): SecretBox => ({
      available: () => true,
      backend: () => name,
      encrypt: async (b) => Buffer.concat([Buffer.from(`${name}:`), b]),
      decrypt: async (b) => {
        const prefix = Buffer.from(`${name}:`);
        if (!b.subarray(0, prefix.length).equals(prefix)) {
          throw new Error("not sealed by this box");
        }
        return b.subarray(prefix.length);
      },
    });
    const sealedDir = () => path.dirname(choiceFile);
    const onPlaintext = async (files: Record<string, string>) => {
      await pickHostSecretBox({
        choiceFile,
        probes: { "systemd-creds": async () => null, libsecret: async () => null },
      });
      for (const [name, text] of Object.entries(files)) {
        fs.writeFileSync(path.join(sealedDir(), name), text, { mode: 0o600 });
      }
    };

    it("re-seals every sealed file with the first stronger backend that appears", async () => {
      await onPlaintext({ "relay-identity.enc": '{"v":1}', "remote-devices.enc": "[]" });
      fs.writeFileSync(path.join(sealedDir(), "manifest.json"), "{}");

      const box = await pickHostSecretBox({
        choiceFile,
        probes: {
          "systemd-creds": async () => null,
          libsecret: async () => sealingBox("libsecret"),
        },
      });
      expect(box.backend()).toBe("libsecret");
      expect(choice()).toBe("libsecret");
      const read = (name: string) => fs.readFileSync(path.join(sealedDir(), name));
      expect((await box.decrypt(read("relay-identity.enc"))).toString()).toBe('{"v":1}');
      expect((await box.decrypt(read("remote-devices.enc"))).toString()).toBe("[]");
      expect(fs.statSync(path.join(sealedDir(), "remote-devices.enc")).mode & 0o777).toBe(0o600);
      // Not a sealed file: left alone.
      expect(read("manifest.json").toString()).toBe("{}");
    });

    it("finishes a run that was cut short without sealing a file twice", async () => {
      await onPlaintext({ "a.enc": "plain-a", "b.enc": "plain-b" });
      const box = sealingBox("systemd-creds");
      // The earlier run sealed `a` and died before the choice was written.
      fs.writeFileSync(path.join(sealedDir(), "a.enc"), await box.encrypt(Buffer.from("plain-a")));
      await pickHostSecretBox({
        choiceFile,
        probes: { "systemd-creds": async () => box },
      });
      for (const [name, text] of [["a.enc", "plain-a"], ["b.enc", "plain-b"]]) {
        const onDisk = fs.readFileSync(path.join(sealedDir(), name));
        expect((await box.decrypt(onDisk)).toString()).toBe(text);
      }
      expect(choice()).toBe("systemd-creds");
    });

    it("stays on plaintext, changing nothing, when the new box cannot seal", async () => {
      await onPlaintext({ "a.enc": "plain-a" });
      const flaky: SecretBox = {
        ...sealingBox("systemd-creds"),
        encrypt: async () => {
          throw new SecretBoxUnavailableError("timed out");
        },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const box = await pickHostSecretBox({
        choiceFile,
        probes: { "systemd-creds": async () => flaky, libsecret: async () => null },
      });
      warn.mockRestore();
      expect(box.backend()).toBe("plaintext");
      expect(choice()).toBe("plaintext");
      expect(fs.readFileSync(path.join(sealedDir(), "a.enc"), "utf8")).toBe("plain-a");
    });

    it("stays on plaintext while nothing stronger works", async () => {
      await onPlaintext({ "a.enc": "plain-a" });
      const box = await pickHostSecretBox({
        choiceFile,
        probes: { "systemd-creds": async () => null, libsecret: async () => null },
      });
      expect(box.backend()).toBe("plaintext");
      expect(fs.readFileSync(path.join(sealedDir(), "a.enc"), "utf8")).toBe("plain-a");
    });
  });

  const realSystemdCreds = (() => {
    const bin = "systemd-creds";
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!realSystemdCreds)(
    "probes the real systemd-creds without throwing",
    async () => {
      const box = await systemdCredsSecretBox();
      if (box) {
        const sealed = await box.encrypt(Buffer.from("x"));
        expect((await box.decrypt(sealed)).toString()).toBe("x");
      }
    },
  );
});
