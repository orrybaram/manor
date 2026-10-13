/**
 * Test helper: read a stream past the host server's hello reply, the way
 * `SshTransport.openServerBridge` hands one over — what is left is bridge
 * frames. No mocks here, so any test may import it.
 */

import type { Readable } from "node:stream";
import {
  awaitHelloLine,
  parseServerHello,
} from "../../terminal-host/transport-ssh";

/**
 * Resolve once `readable` has said the server's hello (`parseServerHello`),
 * with the bytes read beyond it put back. Rejects when the server refuses
 * the owner, or when the stream ends or errors first.
 */
export async function readPastServerHello(readable: Readable): Promise<void> {
  const ended = new Promise<never>((_resolve, reject) => {
    readable.once("error", reject);
    readable.once("close", () =>
      reject(new Error("the stream ended before the hello")),
    );
  });
  ended.catch(() => {});
  const { rest } = await Promise.race([
    awaitHelloLine(readable, parseServerHello),
    ended,
  ]);
  if (rest.length > 0) readable.unshift(rest);
}
