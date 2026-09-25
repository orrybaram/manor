/**
 * Per-socket dispatch of control requests for the terminal-host daemon.
 *
 * Most control requests are handled strictly in arrival order: an async
 * handler (e.g. getSnapshot awaiting flushHeadless) must not let a later
 * request overtake it, since terminal operations depend on that order.
 *
 * `exec` and `readFile` are different: they can take as long as the command
 * they run, and holding the queue for that long would stall every other
 * request on the socket until the client's own timeout tore the connection
 * down. They are *started* in order — so an `exec` sent right after `auth`
 * still sees the socket authenticated — but the queue moves on without
 * waiting for them, and their responses go out whenever they finish. The
 * client matches responses by `requestId`, not by position.
 */

import type { ControlRequest } from "./types";

type RequestWithId = ControlRequest & { requestId?: string };

/** Request types whose completion does not hold up the socket's queue. */
const UNSERIALIZED_REQUEST_TYPES: ReadonlySet<ControlRequest["type"]> = new Set<
  ControlRequest["type"]
>(["exec", "readFile"]);

function isUnserializedRequest(type: ControlRequest["type"]): boolean {
  return UNSERIALIZED_REQUEST_TYPES.has(type);
}

/**
 * Build a line handler that parses each control request and runs `handler`
 * on it — serialized, except for the long-running types above.
 *
 * `onError` reports a handler that threw; `onInvalidJson` a line that did not
 * parse.
 */
export function createSerializedHandler(
  handler: (request: RequestWithId) => Promise<void>,
  onError: (requestId: string | undefined, err: unknown) => void,
  onInvalidJson: () => void,
): (line: string) => void {
  let queue: Promise<void> = Promise.resolve();
  return (line: string) => {
    let request: RequestWithId;
    try {
      request = JSON.parse(line);
    } catch {
      onInvalidJson();
      return;
    }
    const requestId = request.requestId;
    const run = () =>
      handler(request).catch((err: unknown) => onError(requestId, err));

    if (isUnserializedRequest(request.type)) {
      // Take our turn to start, then release the queue immediately.
      queue = queue.then(() => {
        void run();
      });
    } else {
      queue = queue.then(run);
    }
  };
}
