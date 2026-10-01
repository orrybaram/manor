import { appCommandResult, type AppCommandResult } from "../../renderer-bridge";
import { method, type HandlerCtx } from "../method";

/**
 * The renderer answering an `appCommands.command` that carried a `requestId`
 * (ADR-180 D5).
 *
 * The only entry on the table that is a *reply* rather than a request. A
 * `requestId` is a UUID main generated and told exactly one connection, so an
 * answer to one is an answer from the renderer that was asked.
 */
function appCommandsResult(_ctx: HandlerCtx, result: AppCommandResult): void {
  appCommandResult(result);
}

export const appCommands = {
  // `appCommands.command` is addressed to the primary window and nowhere
  // else, so a device never receives one and has nothing to answer.
  result: method(appCommandsResult, { localOnly: true }),
};
