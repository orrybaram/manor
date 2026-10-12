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

export type SecretBackend =
  | "safeStorage"
  | "systemd-creds"
  | "libsecret"
  | "plaintext"
  | "env";

export interface SecretBox {
  /** Can this box encrypt right now? Callers refuse to store when it cannot. */
  available(): boolean;
  backend(): SecretBackend;
  encrypt(plain: Buffer): Promise<Buffer>;
  decrypt(sealed: Buffer): Promise<Buffer>;
}

/** Result of running a helper binary. `code` is null when it could not spawn. */
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

type HostBackend = "systemd-creds" | "libsecret" | "plaintext";

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

/**
 * The first working backend: systemd-creds, then libsecret, then plaintext.
 * The pick is persisted: a backend that later disappears is an error naming
 * it, not a silent fall back to writing plaintext over keys that are still
 * sealed with the old one.
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
  if (chosen) {
    const box = await probes[chosen]();
    if (!box) {
      throw new Error(
        `Pairing keys were encrypted with ${chosen}, which is no longer available`,
      );
    }
    return box;
  }

  for (const name of BACKEND_ORDER) {
    const box = await probes[name]();
    if (!box) continue;
    fs.mkdirSync(path.dirname(opts.choiceFile), { recursive: true });
    fs.writeFileSync(opts.choiceFile, JSON.stringify({ backend: name }), {
      mode: 0o600,
    });
    return box;
  }
  // Unreachable: plaintext always works.
  throw new Error("No secret storage backend is available");
}
