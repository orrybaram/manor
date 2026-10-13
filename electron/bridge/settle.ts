/**
 * What a result frame means to the caller that sent the invoke: its value,
 * or the error to throw. One place for every bridge client — the renderer's
 * two transports (`src/bridge/client.ts`) and the desktop's owner channel to
 * a host server (`backend/host-server-client.ts`) — so none decides for
 * itself what `unavailable:*` means.
 *
 * Imports only `./types`, so the renderer bundles can read it.
 */

import { UNAVAILABLE_CODE, isUnavailableCode, type ResultFrame } from "./types";

/**
 * The server does not implement this, and never will there.
 *
 * Its own type so a component can `catch` it and render the stated empty
 * state ADR-178 promises instead of a crash — `err instanceof
 * BridgeUnavailableError`, not a string match on a message.
 */
export class BridgeUnavailableError extends Error {
  /**
   * `unavailable:web` from the desktop, `unavailable:host` from a host server
   * (ADR-218 D6). The renderer treats every `unavailable:*` alike.
   */
  readonly code: string;
  constructor(message: string, code: string = UNAVAILABLE_CODE) {
    super(message);
    this.code = code;
    this.name = "BridgeUnavailableError";
  }
}

/**
 * A result frame as the value its call resolves with, or a throw:
 * `BridgeUnavailableError` for an `unavailable:*` refusal, a plain `Error`
 * carrying the server's message for anything else.
 */
export function settleResult(frame: ResultFrame): unknown {
  if (frame.ok === true) return frame.result;
  const message =
    typeof frame.error === "string" ? frame.error : "The host refused";
  throw isUnavailableCode(frame.code)
    ? new BridgeUnavailableError(message, frame.code)
    : new Error(message);
}
