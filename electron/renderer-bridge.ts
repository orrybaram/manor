/**
 * The main→renderer app-command round trip, and the HTTP-shaped helpers built
 * on it.
 *
 * Not a route: the `/panes`, `/agents`, and `/projects` route modules call
 * into this for the renderer round-trip, but it has no `Route` entries of its
 * own. Lives at the top level, alongside `webview-server.ts` and
 * `preload.ts`, which import it directly.
 *
 * **Both directions are bridge frames now (ADR-180 D5).** Out was
 * `win.webContents.send("app-command", …)` to `BrowserWindow.getAllWindows()
 * [0]`; it is an `appCommands.command` event addressed to the primary
 * window's connection. Back was `ipcMain.on("app-command-result")`; it is an
 * ordinary `appCommands.result` invoke on the handler table, which is what a
 * renderer answering a question always should have been. The pending map,
 * the correlation id and the timeout are unchanged — what changed is the
 * pipe, and the fact that a browser could answer over the same one.
 *
 * This file must stay off `bridge/server.ts` and its transports: the handler
 * table imports `appCommandResult` from here, so reaching back the other way
 * would close a cycle. It addresses the window through `renderer-broadcast.
 * ts`, which is a leaf for exactly that reason.
 */

import crypto from "node:crypto";
import { BrowserWindow } from "electron";
import type { Json } from "./routes/types";
import {
  connectionIdForWindow,
  publishRendererBroadcast,
  publishToRenderer,
} from "./renderer-broadcast";

/**
 * The payload of an `appCommands.command` event.
 *
 * Two semantics share it. Without a `requestId` the send is fire-and-forget
 * (`run-setup-script` — the renderer has nothing meaningful to report back).
 * With one, the renderer *must* answer with an `appCommands.result` invoke
 * and main awaits it; see `requestRenderer`.
 */
export interface AppCommand {
  cmd: string;
  /** Present iff main expects a reply on "app-command-result". */
  requestId?: string;
  workspacePath?: string;
  prompt?: string;
  script?: string;
  /** Free-form args for correlated pane/tab commands. */
  args?: Record<string, unknown>;
}

/** The argument of the renderer's `appCommands.result` invoke. */
export interface AppCommandResult {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Settled shape of a `requestRenderer` call. Never rejects — see below.
 *
 * `kind` distinguishes the two ways a request can fail: "unavailable" (no
 * window to ask, or it never answered) versus "handler" (it answered, and the
 * answer was `ok: false` — a renderer-side handler threw). The two map to
 * different HTTP statuses in `proxyToRenderer`.
 */
export type RendererResponse<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "unavailable" | "handler"; error: string };

interface PendingRequest {
  resolve: (response: RendererResponse<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-flight `requestRenderer` calls, keyed by `requestId`. */
const pendingRequests = new Map<string, PendingRequest>();

/**
 * A renderer answering an app-command that carried a `requestId`.
 *
 * `HANDLERS["appCommands.result"]` (ADR-180 D5), and the whole of what used
 * to be a lazily installed `ipcMain.on("app-command-result")` listener. The
 * reply was always a call the renderer makes to the host, so it is an
 * ordinary invoke now; the correlation id, the pending map and the timeout
 * below are untouched.
 */
export function appCommandResult(result: AppCommandResult): void {
  if (!result || typeof result.requestId !== "string") return;
  const pending = pendingRequests.get(result.requestId);
  // Unknown id: a reply that arrived after its request timed out, or a
  // renderer replying to a command that never asked for one. Drop it.
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRequests.delete(result.requestId);
  pending.resolve(
    result.ok
      ? { ok: true, data: result.data }
      : {
          ok: false,
          kind: "handler",
          error: result.error ?? "Unknown error",
        },
  );
}

/**
 * The connection an app-command goes to: the primary window's.
 *
 * `getAllWindows()[0]` is the window this has always meant. Null covers one
 * more case than it used to — a window that is open but whose page has not
 * installed the bridge yet — and both are the same answer to the same
 * question ("is there a renderer that can hear this"), so both become the
 * same 503.
 */
function primaryConnection(): string | null {
  return connectionIdForWindow(BrowserWindow.getAllWindows()[0]);
}

/**
 * Send an app-command the renderer must answer, and await the answer.
 *
 * Resolves rather than rejects on every failure path (no window, timeout,
 * handler error) — callers are HTTP route handlers that map `ok: false` onto a
 * status code, and an unhandled rejection there would surface as a 500.
 */
export function requestRenderer(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<RendererResponse<unknown>> {
  const to = primaryConnection();
  if (to === null) {
    return Promise.resolve({
      ok: false,
      kind: "unavailable",
      error: "No Manor window is open",
    });
  }

  const requestId = crypto.randomUUID();
  return new Promise<RendererResponse<unknown>>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({
        ok: false,
        kind: "unavailable",
        error: "Renderer did not respond",
      });
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, timer });
    const command: AppCommand = { cmd, requestId, ...(args ? { args } : {}) };
    publishToRenderer(to, "appCommands", "command", command);
  });
}

/**
 * Round-trip a command to the renderer and write its answer as the response
 * body. The `/panes` and `/tabs` routes are nothing but validation followed by
 * this, five times over.
 *
 * The status is known at the point of failure, via `result.kind`: no window,
 * or the renderer never answered, is `503`; a renderer handler throwing —
 * bad `paneId`, unknown workspace, invalid enum — is the caller's fault, `400`.
 */
export async function proxyToRenderer(
  json: Json,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<void> {
  const result = await requestRenderer(cmd, args);
  if (!result.ok) {
    json(result.kind === "unavailable" ? 503 : 400, { error: result.error });
    return;
  }
  json(200, result.data);
}

/**
 * Ask the renderer to run the project's worktree start script in a new
 * workspace. Like agents, the script needs a PTY the renderer owns, so main
 * hands it off as an app-command. Best-effort: with no renderer attached
 * there is nowhere to run it.
 */
export function runSetupScript(workspacePath: string, script: string): void {
  const to = primaryConnection();
  if (to === null) return;
  const command: AppCommand = {
    cmd: "run-setup-script",
    workspacePath,
    script,
  };
  publishToRenderer(to, "appCommands", "command", command);
}

/**
 * Tell the renderer its project list is stale. Mutations that originate in the
 * renderer fold the result straight into the store, but ones that arrive over
 * the control server (MCP, `manor` CLI) have no such return path — without this
 * the sidebar keeps showing the pre-mutation list until something else refetches.
 */
export function notifyProjectsChanged(): void {
  // One signal for every renderer, browser and window alike (ADR-180 ticket
  // 6). The `webContents.send("projects-changed")` that used to sit beside
  // this went with the `projects` namespace: a window is a bridge connection
  // now, and `onProjectsChanged(cb)` is a subscription to this frame.
  publishRendererBroadcast("projects", "changed");
}
