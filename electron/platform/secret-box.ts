/**
 * The secret-storage port (ADR-218 D6).
 *
 * Everything the remote-control and relay modules persist as a secret (device
 * token hashes, the relay identity, the VAPID key, the Linear key) goes
 * through a `SecretBox`, so the same code runs under Electron (`safeStorage`,
 * see `electron-secret-box.ts`) and on a headless host server (the backends
 * below).
 *
 * This module must stay Electron-free — the host server bundles it.
 *
 * The host backends shell out, so `encrypt`/`decrypt` are async. Secrets only
 * ever travel through a child's stdin/stdout, never argv (argv is readable by
 * every process on the box).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic, writeFileAtomicAsync } from "../lib/fs-atomic";

export type SecretBackend =
  | "safeStorage"
  | "systemd-creds"
  | "libsecret"
  | "plaintext";

export interface SecretBox {
  /**
   * Can this box store a secret right now: sealed, or knowingly in plaintext
   * (`plainFileSecretBox`, which the host server warns about)? Callers refuse
   * to store when it cannot.
   */
  available(): boolean;
  backend(): SecretBackend;
  encrypt(plain: Buffer): Promise<Buffer>;
  decrypt(sealed: Buffer): Promise<Buffer>;
}

/**
 * The box could not do its job at all: its helper would not spawn, timed out,
 * or the backend it was set up with has gone. Distinct from a decrypt that ran
 * and failed (a corrupt or foreign file), which is a plain `Error`. A store
 * must not answer this by starting over: the file is probably fine, and
 * writing a fresh one over it would throw away every pairing for a hiccup.
 */
export class SecretBoxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxUnavailableError";
  }
}

/**
 * Result of running a helper binary. `code` is null when it could not run:
 * it would not spawn, or it timed out.
 */
export interface ExecResult {
  code: number | null;
  stdout: Buffer;
}

/** Runs `cmd args`, feeding `input` to stdin. Injectable so tests need no binaries. */
export type ExecFn = (
  cmd: string,
  args: string[],
  input?: Buffer,
) => Promise<ExecResult>;

const EXEC_TIMEOUT_MS = 10_000;

export const defaultExec: ExecFn = (cmd, args, input) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve({ code: null, stdout: Buffer.alloc(0) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout: Buffer.alloc(0) });
    }, EXEC_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => done({ code: null, stdout: Buffer.alloc(0) }));
    child.on("close", (code) => done({ code, stdout: Buffer.concat(chunks) }));
    // A child that exits before reading stdin raises EPIPE; `close` reports it.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

// ── plaintext ──

/**
 * The identity function. Callers already write their files 0600, so on a
 * machine with no keyring this is what "protected by file permissions" means.
 */
export const plainFileSecretBox: SecretBox = {
  available: () => true,
  backend: () => "plaintext",
  encrypt: async (plain) => Buffer.from(plain),
  decrypt: async (sealed) => Buffer.from(sealed),
};

// ── systemd-creds ──

const SYSTEMD_CREDS_MIN_VERSION = 256;
const CREDENTIAL_NAME = "manor";
const PROBE_PAYLOAD = Buffer.from("manor-secret-box-probe");

function systemdCredsBox(exec: ExecFn): SecretBox {
  const run = async (verb: "encrypt" | "decrypt", input: Buffer) => {
    const { code, stdout } = await exec(
      "systemd-creds",
      ["--user", verb, `--name=${CREDENTIAL_NAME}`, "-", "-"],
      input,
    );
    if (code === null) {
      throw new SecretBoxUnavailableError(
        `systemd-creds ${verb} could not run (missing, or timed out)`,
      );
    }
    if (code !== 0) throw new Error(`systemd-creds ${verb} failed`);
    return stdout;
  };
  return {
    available: () => true,
    backend: () => "systemd-creds",
    encrypt: (plain) => run("encrypt", plain),
    decrypt: (sealed) => run("decrypt", sealed),
  };
}

/**
 * systemd-creds ≥ 256 (the first with `--user`), confirmed by an encrypt and
 * decrypt round trip. Null when anything about that fails.
 */
export async function systemdCredsSecretBox(
  exec: ExecFn = defaultExec,
): Promise<SecretBox | null> {
  const version = await exec("systemd-creds", ["--version"]);
  if (version.code !== 0) return null;
  const major = /(\d+)/.exec(version.stdout.toString("utf8"))?.[1];
  if (!major || Number(major) < SYSTEMD_CREDS_MIN_VERSION) return null;
  const box = systemdCredsBox(exec);
  try {
    const sealed = await box.encrypt(PROBE_PAYLOAD);
    const opened = await box.decrypt(sealed);
    return opened.equals(PROBE_PAYLOAD) ? box : null;
  } catch {
    return null;
  }
}

// ── libsecret ──

const KEY_ATTRS = ["service", "manor-host", "kind", "data-key"];
const PROBE_ATTRS = ["service", "manor-host", "kind", "probe"];
const DATA_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

async function secretToolLookup(
  exec: ExecFn,
  attrs: string[],
): Promise<Buffer | null> {
  const { code, stdout } = await exec("secret-tool", ["lookup", ...attrs]);
  return code === 0 && stdout.length > 0 ? stdout : null;
}

async function secretToolStore(
  exec: ExecFn,
  attrs: string[],
  value: Buffer,
): Promise<boolean> {
  // The secret goes in on stdin; only the label and attributes are argv.
  const { code } = await exec(
    "secret-tool",
    ["store", "--label=Manor host", ...attrs],
    value,
  );
  return code === 0;
}

/**
 * Keep one random data key in the Secret Service keyring and seal the files
 * ourselves with AES-256-GCM (the keyring is for small secrets, and this keeps
 * `secret-tool` off the hot path). Null without a session bus or when the
 * keyring does not round-trip.
 */
export async function libsecretSecretBox(
  exec: ExecFn = defaultExec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecretBox | null> {
  if (!env.DBUS_SESSION_BUS_ADDRESS) return null;
  const probe = Buffer.from(crypto.randomBytes(8).toString("hex"));
  if (!(await secretToolStore(exec, PROBE_ATTRS, probe))) return null;
  const read = await secretToolLookup(exec, PROBE_ATTRS);
  await exec("secret-tool", ["clear", ...PROBE_ATTRS]);
  if (!read || !read.equals(probe)) return null;

  let key: Buffer;
  const existing = await secretToolLookup(exec, KEY_ATTRS);
  if (existing) {
    key = Buffer.from(existing.toString("utf8").trim(), "base64");
    if (key.length !== DATA_KEY_BYTES) return null;
  } else {
    key = crypto.randomBytes(DATA_KEY_BYTES);
    const stored = await secretToolStore(
      exec,
      KEY_ATTRS,
      Buffer.from(key.toString("base64")),
    );
    if (!stored) return null;
  }

  return {
    available: () => true,
    backend: () => "libsecret",
    encrypt: async (plain) => {
      const iv = crypto.randomBytes(GCM_IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt: async (sealed) => {
      if (sealed.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
        throw new Error("sealed data is too short");
      }
      const iv = sealed.subarray(0, GCM_IV_BYTES);
      const tag = sealed.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(sealed.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)),
        decipher.final(),
      ]);
    },
  };
}

// ── choosing one ──

type HostBackend = Exclude<SecretBackend, "safeStorage">;

const BACKEND_ORDER: HostBackend[] = ["systemd-creds", "libsecret", "plaintext"];

export interface PickHostSecretBoxOptions {
  /**
   * Where the choice is remembered (JSON). No default: the host server passes a
   * file in its data dir.
   */
  choiceFile: string;
  /** Probe overrides, for tests. Each returns null when the backend is unusable. */
  probes?: Partial<Record<HostBackend, () => Promise<SecretBox | null>>>;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
}

function readChoice(file: string): HostBackend | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      backend?: unknown;
    };
    return BACKEND_ORDER.find((b) => b === parsed.backend) ?? null;
  } catch {
    return null;
  }
}

function writeChoice(file: string, backend: HostBackend): void {
  writeFileAtomic(file, JSON.stringify({ backend }), { mode: 0o600 });
}

/** Sealed files live beside the choice file and end in `.enc` (`hostServerPaths`). */
const SEALED_SUFFIX = ".enc";

/**
 * Move every sealed file beside `choiceFile` from plaintext to `box`, then
 * remember `box` as the choice. Returns false, having changed nothing, when
 * `box` cannot seal them all.
 *
 * Crash-safe by being idempotent: the choice is written last, so a run cut
 * short is retried on the next start, and a file `box` already opens was
 * sealed by that earlier run and is left alone. Every file is sealed in memory
 * before any is written, so a box that fails part way leaves them all as
 * plaintext. A write that fails part way throws: carrying on with the
 * plaintext box would read the files already sealed as garbage.
 */
async function upgradeFromPlaintext(
  choiceFile: string,
  name: HostBackend,
  box: SecretBox,
): Promise<boolean> {
  const dir = path.dirname(choiceFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(SEALED_SUFFIX));
  } catch {
    names = [];
  }
  const sealed: Array<{ file: string; data: Buffer }> = [];
  try {
    for (const entry of names) {
      const file = path.join(dir, entry);
      const plain = fs.readFileSync(file);
      const already = await box.decrypt(plain).then(
        () => true,
        (err: unknown) => {
          if (err instanceof SecretBoxUnavailableError) throw err;
          return false;
        },
      );
      if (!already) sealed.push({ file, data: await box.encrypt(plain) });
    }
  } catch (err) {
    console.warn(
      `[secret-box] could not move pairing keys to ${name}; staying on plaintext:`,
      err,
    );
    return false;
  }
  for (const { file, data } of sealed) {
    await writeFileAtomicAsync(file, data, { mode: 0o600 });
  }
  writeChoice(choiceFile, name);
  console.info(
    `[secret-box] moved ${sealed.length} pairing key file(s) from plaintext to ${name}`,
  );
  return true;
}

/**
 * The first working backend: systemd-creds, then libsecret, then plaintext.
 * The pick is persisted: a backend that later disappears is an error naming
 * it, not a silent fall back to writing plaintext over keys that are still
 * sealed with the old one.
 *
 * Plaintext is the one choice that is not sticky. It is only ever a last
 * resort, so each start on it probes the stronger backends again, and the
 * first that works takes over: every sealed file is re-sealed with it, then
 * it becomes the choice.
 */
export async function pickHostSecretBox(
  opts: PickHostSecretBoxOptions,
): Promise<SecretBox> {
  const exec = opts.exec ?? defaultExec;
  const probes: Record<HostBackend, () => Promise<SecretBox | null>> = {
    "systemd-creds": () => systemdCredsSecretBox(exec),
    libsecret: () => libsecretSecretBox(exec, opts.env),
    plaintext: async () => plainFileSecretBox,
    ...opts.probes,
  };

  const chosen = readChoice(opts.choiceFile);
  if (chosen === "plaintext") {
    for (const name of BACKEND_ORDER) {
      if (name === "plaintext") break;
      const box = await probes[name]();
      if (box && (await upgradeFromPlaintext(opts.choiceFile, name, box))) {
        return box;
      }
    }
    return (await probes.plaintext()) ?? plainFileSecretBox;
  }
  if (chosen) {
    const box = await probes[chosen]();
    if (!box) {
      throw new SecretBoxUnavailableError(
        `Pairing keys were encrypted with ${chosen}, which is no longer available`,
      );
    }
    return box;
  }

  for (const name of BACKEND_ORDER) {
    const box = await probes[name]();
    if (!box) continue;
    writeChoice(opts.choiceFile, name);
    return box;
  }
  // Unreachable: plaintext always works.
  throw new Error("No secret storage backend is available");
}
