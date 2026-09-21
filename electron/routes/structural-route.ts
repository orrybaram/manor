/**
 * The structural-route factory (ADR-182 D8).
 *
 * A structural route is a `structural({ parse, locate, command, respond })`
 * spec. The factory owns everything those routes used to repeat: the 400
 * for a bad argument, the workspace resolution and
 * its `NO_WORKSPACE_ERROR`, the 400 for an id no workspace holds, a pending
 * shell line for a minted pane, and the 400 for a refused command.
 */

import type { Route } from "./types";
import type {
  LayoutOrigin,
  LayoutStore,
  LayoutTarget,
} from "../layout/layout-store";
import type { PendingCommandKind } from "../layout/pending-commands";
import type { LayoutCommand } from "../../src/lib/layout/commands";
import type {
  LayoutApplyResult,
  LayoutEntry,
} from "../../src/lib/layout/protocol";

/** Every command from these routes names the same sender. */
const ROUTE_ORIGIN: LayoutOrigin = { kind: "route", id: "cli" };

const NO_WORKSPACE_ERROR =
  "No workspace: pass workspacePath, name a paneId/tabId already open in one, or open a workspace first";

type Body = Record<string, unknown>;
type Applied = Exclude<LayoutApplyResult, { error: string }>;

/** The workspace a request resolved to, and its entry — null before the
 *  first command creates it. */
export interface At {
  store: LayoutStore;
  workspacePath: string;
  entry: LayoutEntry | null;
}

/** The pane or tab a request is about. `unknown` replaces the default
 *  `Unknown paneId: …` answer when the resolved workspace lacks it. */
type Located = LayoutTarget & { unknown?: string };

/** A shell line for a pane the command mints; `text` absent queues nothing. */
interface Pending {
  paneId: string;
  text: string | undefined;
  kind?: PendingCommandKind;
}

interface Structural<P, C extends LayoutCommand> {
  /** Validate the request. A throw here, or in `command`, is a 400. */
  parse?: (req: { body: Body; params: Record<string, string> }) => P;
  /** Names the workspace when the body does not, and must be in it. */
  locate?: (parsed: P) => Located | undefined;
  /** A 200 answer that makes the command unnecessary, when there is one. */
  answer?: (parsed: P, at: At) => unknown;
  command: (parsed: P, at: At) => C;
  pending?: (parsed: P, command: C) => Pending;
  respond: (done: { parsed: P; command: C; result: Applied; at: At }) => unknown;
}

/**
 * One structural route's handler.
 *
 * Which workspace, the same way every time (ADR-179 D5): `body.workspacePath`
 * always wins; failing that, the workspace holding the located pane or tab
 * (it lives in exactly one); failing that, the last-active workspace, the
 * only thing left to try before answering 400.
 *
 * A pending line is queued before the `apply`, never after: the broadcast is
 * what makes a renderer mount the pane, and a mount that reached
 * `pty.create` first would find nothing waiting. A refused command clears it.
 */
export function structural<P = undefined, C extends LayoutCommand = LayoutCommand>(
  spec: Structural<P, C>,
): Route["handler"] {
  return async ({ deps, params, json, readBody }) => {
    const store = deps.layoutStore;
    const body = await readBody();
    try {
      const parsed = spec.parse
        ? spec.parse({ body, params })
        : (undefined as P);
      const target = spec.locate?.(parsed);
      const located = target ? store.locate(target) : null;
      const workspacePath =
        (typeof body.workspacePath === "string" && body.workspacePath) ||
        located?.workspacePath ||
        store.getLastActiveWorkspacePath();
      if (!workspacePath) {
        json(400, { error: NO_WORKSPACE_ERROR });
        return;
      }
      if (target && located?.workspacePath !== workspacePath) {
        json(400, {
          error:
            target.unknown ??
            ("paneId" in target
              ? `Unknown paneId: ${target.paneId}`
              : `Unknown tabId: ${target.tabId}`),
        });
        return;
      }

      const at: At = {
        store,
        workspacePath,
        entry: located?.entry ?? store.get(workspacePath),
      };
      const answer = spec.answer?.(parsed, at);
      if (answer !== undefined) {
        json(200, answer);
        return;
      }
      const command = spec.command(parsed, at);
      const pending = spec.pending?.(parsed, command);
      if (pending?.text) {
        store.pendingCommands.set(
          pending.paneId,
          pending.text,
          pending.kind ?? "shell",
        );
      }
      const result = await store.apply(workspacePath, command, ROUTE_ORIGIN);
      if ("error" in result) {
        if (pending) store.pendingCommands.clear(pending.paneId);
        json(400, { error: result.error });
        return;
      }
      json(200, spec.respond({ parsed, command, result, at }));
    } catch (err) {
      // A validation throw, answered the way a renderer-side throw was.
      json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/** A `/tabs/:tabId/*` route that needs only the tab to exist. */
export function tabRoute<C extends LayoutCommand>(
  path: string,
  command: (tabId: string, at: At) => C,
  respond: (tabId: string, command: C, at: At) => unknown = () => ({ ok: true }),
): Route {
  return {
    method: "POST",
    path,
    handler: structural({
      parse: ({ params }) => params.tabId,
      locate: (tabId) => ({ tabId }),
      command,
      respond: ({ parsed, command: sent, at }) => respond(parsed, sent, at),
    }),
  };
}
