/**
 * Kitty keyboard protocol negotiation, answered on xterm.js's behalf (it does
 * not implement the protocol natively).
 *
 * The sequences are taken from xterm's own parser rather than matched in each
 * output chunk, so one split across two chunks — or arriving inside a queued
 * warm-restore replay — is still seen whole:
 *
 *   CSI > flags u  — push mode (track the flags)
 *   CSI < u        — pop mode
 *   CSI ? u        — query current mode (reply with the flags)
 *
 * Handled sequences are swallowed, so none of them reach the screen.
 */

import type { IDisposable, IParser } from "@xterm/xterm";

/** The part of a terminal this needs — xterm's `Terminal`, headless or not. */
export interface KittyKeyboardTerminal {
  readonly parser: Pick<IParser, "registerCsiHandler">;
}

/**
 * Answer kitty keyboard protocol sequences written to `term`, sending query
 * replies through `reply` (the pty's input). Disposing the result — or the
 * terminal — removes the handlers.
 */
export function installKittyKeyboard(
  term: KittyKeyboardTerminal,
  reply: (data: string) => void,
): IDisposable {
  let flags = 0;
  const handlers = [
    term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      const first = params[0];
      flags = typeof first === "number" ? first : 0;
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: "<", final: "u" }, () => {
      flags = 0;
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
      reply(`\x1b[?${flags}u`);
      return true;
    }),
  ];
  return {
    dispose: () => {
      for (const handler of handlers) handler.dispose();
    },
  };
}
