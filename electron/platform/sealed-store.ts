/**
 * Encrypted-at-rest JSON state over a `SecretBox` (ADR-225 D6, ADR-226): the
 * one sealed store the remote-control stores (paired devices, the relay
 * identity, the VAPID key) are built on.
 *
 * `encrypt` is async, but the stores' APIs are synchronous (`verify()` sits on
 * the hello path). So a store decrypts once up front into memory (`init()`),
 * and mutations hand the new state to `write()`, which seals and writes in
 * call order in the background. `flush()` waits for the queue; an operation
 * that must be durable before it is acknowledged (pairing, revoking) awaits
 * it, and so does the app on quit.
 *
 * Three rules, each the fix for a way pairings used to get lost:
 *
 *   - Every write is atomic (temp file, then rename), so a quit or crash mid
 *     write leaves the old file, never a torn one that reads as corrupt.
 *   - A failed write is not swallowed. `flush()` rejects with it, and every
 *     later `write()` throws it: a store whose disk state is unknown does not
 *     keep reporting success.
 *   - Only a file that is missing, or one that was read and could not be
 *     opened or parsed, reads as "nothing stored". A box that could not run at
 *     all (`SecretBoxUnavailableError`) or a file that could not be read is
 *     rethrown: starting fresh there would overwrite a file that is fine.
 */
import fs from "node:fs";

import { writeFileAtomicAsync } from "../lib/fs-atomic";
import { SecretBoxUnavailableError, type SecretBox } from "./secret-box";

/** Raised when the box cannot store a secret, so a write must not proceed. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      "OS encryption is unavailable, so a remote-control secret cannot be " +
        "stored safely. Remote control stays off rather than writing it to " +
        "disk in plaintext.",
    );
    this.name = "EncryptionUnavailableError";
  }
}

/** How a store's state becomes the text that is sealed, and back. */
export interface SealedCodec<T> {
  /** The state in `text`, or null when it is not a valid state (corrupt). */
  parse(text: string): T | null;
  serialize(value: T): string;
}

const FILE_MODE = 0o600;

async function readBytes(file: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The decrypted text of `file`, or null when there is no file. Throws when it
 * cannot be read or decrypted.
 */
export async function readSealed(
  box: SecretBox,
  file: string,
): Promise<string | null> {
  const sealed = await readBytes(file);
  if (sealed === null) return null;
  return (await box.decrypt(sealed)).toString("utf8");
}

/** Seal `text` into `file`, atomically, mode 0600. */
export async function writeSealed(
  box: SecretBox,
  file: string,
  text: string,
): Promise<void> {
  const sealed = await box.encrypt(Buffer.from(text, "utf8"));
  await writeFileAtomicAsync(file, sealed, { mode: FILE_MODE });
}

export class SealedStore<T> {
  private tail: Promise<void> = Promise.resolve();
  /** The first write that failed; once set, the store takes no more writes. */
  private failure: { error: unknown } | null = null;

  constructor(
    private readonly box: SecretBox,
    private readonly file: string,
    /** For logs, e.g. "paired devices". */
    private readonly label: string,
    private readonly codec: SealedCodec<T>,
  ) {}

  /**
   * The stored state, or null when there is none to use: no file, or one this
   * install cannot open or parse (a restored backup, a new keychain, a torn
   * write from an older build), which is logged. Rethrows
   * `SecretBoxUnavailableError` and read errors other than a missing file.
   */
  async init(): Promise<T | null> {
    const sealed = await readBytes(this.file);
    if (sealed === null) return null;
    let text: string;
    try {
      text = (await this.box.decrypt(sealed)).toString("utf8");
    } catch (err) {
      if (err instanceof SecretBoxUnavailableError) throw err;
      console.warn(
        `[sealed-store] ${this.label} could not be decrypted; starting fresh`,
      );
      return null;
    }
    let value: T | null;
    try {
      value = this.codec.parse(text);
    } catch {
      value = null;
    }
    if (value === null) {
      console.warn(`[sealed-store] ${this.label} is corrupt; starting fresh`);
    }
    return value;
  }

  /**
   * Queue `value` to be sealed and written after everything queued before it.
   * Throws `EncryptionUnavailableError` when the box cannot store, and the
   * first failure when an earlier write failed.
   */
  write(value: T): void {
    if (!this.box.available()) throw new EncryptionUnavailableError();
    if (this.failure) throw this.failure.error;
    const text = this.codec.serialize(value);
    this.tail = this.tail.then(async () => {
      // A write queued behind one that failed is not attempted: the store is
      // already reporting that failure, and must keep reporting the same one.
      if (this.failure) return;
      try {
        await writeSealed(this.box, this.file, text);
      } catch (error) {
        this.failure ??= { error };
        console.error(`[sealed-store] could not persist ${this.label}:`, error);
      }
    });
  }

  /** Resolves once every queued write has landed; rejects with the first failure. */
  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure.error;
  }
}
