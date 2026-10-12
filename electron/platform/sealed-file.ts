/**
 * Encrypted-at-rest files over a `SecretBox` (ADR-218 D6): the read and write
 * halves the remote-control stores share.
 *
 * `encrypt` is async, but the stores' APIs are synchronous (`verify()` sits on
 * the hello path). So a store decrypts once up front into memory (`readSealed`
 * in its async `init()`), and mutations hand the new state to a `SealedWriter`,
 * which seals and writes in call order in the background. `flush()` waits for
 * the queue; the app awaits it on shutdown and tests await it before reading
 * the file back.
 */
import fs from "node:fs";
import path from "node:path";

import type { SecretBox } from "./secret-box";

/** The decrypted text of `file`. Throws on a missing file or a failed decrypt. */
export async function readSealed(
  box: SecretBox,
  file: string,
): Promise<string> {
  return (await box.decrypt(await fs.promises.readFile(file))).toString("utf8");
}

export async function writeSealed(
  box: SecretBox,
  file: string,
  text: string,
): Promise<void> {
  const sealed = await box.encrypt(Buffer.from(text, "utf8"));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, sealed, { mode: 0o600 });
  // `mode` only applies when the file is created, so an existing file keeps
  // whatever it had. Restate it every write.
  await fs.promises.chmod(file, 0o600);
}

export class SealedWriter {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly box: SecretBox,
    private readonly file: string,
    private readonly label: string,
  ) {}

  /** Queue `text` to be sealed and written after everything queued before it. */
  write(text: string): void {
    this.tail = this.tail.then(() =>
      writeSealed(this.box, this.file, text).catch((err) => {
        console.warn(`[remote-control] could not persist ${this.label}:`, err);
      }),
    );
  }

  /** Resolves once every queued write has landed. */
  flush(): Promise<void> {
    return this.tail;
  }
}
