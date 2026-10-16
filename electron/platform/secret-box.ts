/**
 * The secret-storage port (ADR-225 D6).
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
import os from "node:os";
import path from "node:path";

import { writeFileAtomic, writeFileAtomicAsync } from "../lib/fs-atomic";

export type SecretBackend =
  | "safeStorage"
  | "systemd-creds"
  | "libsecret"
  | "key-file"
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

// ── key-file ──

const KEY_FILE_HEADER = Buffer.from("MKF1");
const KEY_ENV = "MANOR_SECRET_KEY";
const KEY_FILE_ENV = "MANOR_SECRET_KEY_FILE";

function keyFromBase64(text: string, source: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== DATA_KEY_BYTES) {
    throw new Error(
      `${source} must be ${DATA_KEY_BYTES} bytes (base64 encoded); got ${key.length}`,
    );
  }
  return key;
}

/** The 32-byte key from `MANOR_SECRET_KEY`, else the file `MANOR_SECRET_KEY_FILE` names. */
function readSecretKey(env: NodeJS.ProcessEnv): Buffer | null {
  const inline = env[KEY_ENV];
  if (inline) return keyFromBase64(inline, KEY_ENV);
  const file = env[KEY_FILE_ENV];
  if (!file) return null;
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    throw new Error(
      `${KEY_FILE_ENV} (${file}) could not be read: ${(err as Error).message}`,
      { cause: err },
    );
  }
  // A raw key is exactly 32 bytes; anything else is read as base64 text.
  if (raw.length === DATA_KEY_BYTES) return Buffer.from(raw);
  return keyFromBase64(raw.toString("utf8"), `${KEY_FILE_ENV} (${file})`);
}

/**
 * AES-256-GCM under a key the operator supplies (ADR-229 D5): `MANOR_SECRET_KEY`
 * (base64), or the file `MANOR_SECRET_KEY_FILE` names (raw 32 bytes or base64
 * text), such as a mounted Kubernetes or Docker secret. Null when neither is
 * set; a key that is set but unusable throws, so a typo is never a silent
 * fall back to a weaker backend.
 *
 * Sealed layout: `MKF1` + nonce (12) + tag (16) + ciphertext.
 */
export function keyFileSecretBox(
  env: NodeJS.ProcessEnv = process.env,
): SecretBox | null {
  const key = readSecretKey(env);
  if (!key) return null;
  const headerLen = KEY_FILE_HEADER.length;
  return {
    available: () => true,
    backend: () => "key-file",
    encrypt: async (plain) => {
      const iv = crypto.randomBytes(GCM_IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([KEY_FILE_HEADER, iv, cipher.getAuthTag(), body]);
    },
    decrypt: async (sealed) => {
      if (
        sealed.length < headerLen + GCM_IV_BYTES + GCM_TAG_BYTES ||
        !sealed.subarray(0, headerLen).equals(KEY_FILE_HEADER)
      ) {
        throw new Error("sealed data is not key-file sealed");
      }
      const ivEnd = headerLen + GCM_IV_BYTES;
      const iv = sealed.subarray(headerLen, ivEnd);
      const tag = sealed.subarray(ivEnd, ivEnd + GCM_TAG_BYTES);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(sealed.subarray(ivEnd + GCM_TAG_BYTES)),
        decipher.final(),
      ]);
    },
  };
}

/**
 * Whether the key `env` names is usable, by the same rules `keyFileSecretBox`
 * reads it with: 32 bytes from `MANOR_SECRET_KEY` (base64), else from the file
 * `MANOR_SECRET_KEY_FILE` names (raw or base64). The error names the variable
 * (and file) at fault, or says neither is set.
 */
export function validateSecretKey(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; error: string } {
  try {
    return readSecretKey(env)
      ? { ok: true }
      : { ok: false, error: `Neither ${KEY_ENV} nor ${KEY_FILE_ENV} is set` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export type SecretKeyPlace = "data-dir" | "home" | "elsewhere";

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Where the key sealing the pairing keys lives (ADR-236 D5):
 * - `data-dir`: a `MANOR_SECRET_KEY_FILE` under `<home>/.manor`, or an inline
 *   `MANOR_SECRET_KEY` written in one of `inlineKeySources` (`supervisor.env`):
 *   on the very volume it protects (ADR-229 D5).
 * - `home`: a key file under home but outside `~/.manor`.
 * - `elsewhere`: a mounted secret, an inline key from the real environment,
 *   or a file that cannot be resolved.
 * Null when neither variable is set. `MANOR_SECRET_KEY` wins when both are,
 * as in `keyFileSecretBox`. Symlinks are resolved, so a mounted secret linked
 * into the data dir is seen for what it is.
 */
export function secretKeyPlace(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  inlineKeySources: readonly string[] = [],
): SecretKeyPlace | null {
  const inline = env[KEY_ENV];
  if (inline) {
    const line = `${KEY_ENV}='${inline}'`;
    for (const source of inlineKeySources) {
      let text: string;
      try {
        text = fs.readFileSync(source, "utf8");
      } catch {
        continue;
      }
      if (text.split("\n").some((l) => l.trim() === line)) return "data-dir";
    }
    return "elsewhere";
  }
  const file = env[KEY_FILE_ENV];
  if (!file) return null;
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return "elsewhere";
  }
  if (isInside(realpathOr(path.join(home, ".manor")), real)) return "data-dir";
  if (isInside(realpathOr(home), real)) return "home";
  return "elsewhere";
}

/**
 * The key file `env` names, for display (ADR-236 D5), with `home` shortened
 * to `~`; null when an inline `MANOR_SECRET_KEY` is the key, as it wins.
 */
export function shownSecretKeyFile(
  env: NodeJS.ProcessEnv,
  home: string = os.homedir(),
): string | null {
  const file = env[KEY_ENV] ? undefined : env[KEY_FILE_ENV];
  if (!file) return null;
  if (home && (file === home || file.startsWith(home + path.sep))) {
    return `~${file.slice(home.length)}`;
  }
  return file;
}

/**
 * Whether the key sits on the volume it seals (`secretKeyPlace` is
 * `data-dir`), which defeats the point (ADR-229 D5). Kept for an older
 * desktop's warning (ADR-236 D5).
 */
export function secretKeyOnVolume(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  inlineKeySources: readonly string[] = [],
): boolean {
  return secretKeyPlace(env, home, inlineKeySources) === "data-dir";
}

// ── choosing one ──

type HostBackend = Exclude<SecretBackend, "safeStorage">;

const BACKEND_ORDER: HostBackend[] = [
  "key-file",
  "systemd-creds",
  "libsecret",
  "plaintext",
];

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

/**
 * The backend `secret-backend` (`choiceFile`) records, or null when there is
 * none yet or it is unreadable.
 */
export function readSecretBackendChoice(file: string): Exclude<SecretBackend, "safeStorage"> | null {
  return readChoice(file);
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
 * The first working backend: key-file when `MANOR_SECRET_KEY` or
 * `MANOR_SECRET_KEY_FILE` is set (ADR-229 D5), then systemd-creds, then
 * libsecret, then plaintext.
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
    "key-file": async () => keyFileSecretBox(opts.env),
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
        chosen === "key-file"
          ? `Pairing keys were sealed with a key from ${KEY_ENV} or ${KEY_FILE_ENV}, and neither is set`
          : `Pairing keys were encrypted with ${chosen}, which is no longer available`,
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
