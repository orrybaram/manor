/**
 * The main→renderer "app-command" channel, and the HTTP-shaped helpers built on
 * it.
 *
 * Not a route: the `/panes`, `/agents`, and `/projects` route modules call
 * into this for the renderer round-trip, but it has no `Route` entries of its
 * own. Lives at the top level, alongside `webview-server.ts` and
 * `preload.ts`, which import it directly.
 */

import crypto from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import type { Json } from "./routes/types";

/**
 * Payload of the main→renderer "app-command" channel.
 *
 * Two semantics share this channel. Without a `requestId` the send is
 * fire-and-forget (`start-agent`, `run-setup-script` — the renderer has nothing
 * meaningful to report back). With one, the renderer *must* reply on
 * "app-command-result" and main awaits it; see `requestRenderer`.
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

/** Payload of the renderer→main "app-command-result" channel. */
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
let resultListenerInstalled = false;

/**
 * Install the single "app-command-result" listener, lazily, on first use.
 *
 * Deliberately `ipcMain.on` and not `ipcMain.once`: a `once` per request leaks
 * a listener for every request that times out before the renderer answers.
 * One listener routes every reply through `pendingRequests` instead.
 */
function installResultListener(): void {
  if (resultListenerInstalled) return;
  resultListenerInstalled = true;
  ipcMain.on(
    "app-command-result",
    (_event: unknown, result: AppCommandResult) => {
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
    },
  );
}

/**
 * Send an "app-command" the renderer must answer, and await the answer.
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
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    return Promise.resolve({
      ok: false,
      kind: "unavailable",
      error: "No Manor window is open",
    });
  }
  installResultListener();

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
    win.webContents.send("app-command", command);
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
 * Ask the renderer to open a new agent pane in the given workspace. Agents are
 * launched by the renderer (App.tsx seeds a shell command), so main round-trips
 * the request over the "app-command" channel.
 */
export function startAgent(
  workspacePath: string,
  prompt?: string,
): { ok: boolean; error?: string } {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    return { ok: false, error: "No Manor window is open" };
  }
  const command: AppCommand = { cmd: "start-agent", workspacePath, prompt };
  win.webContents.send("app-command", command);
  return { ok: true };
}

/**
 * Ask the renderer to run the project's worktree start script in a new
 * workspace. Like agents, the script needs a PTY the renderer owns, so main
 * hands it off over the "app-command" channel. Best-effort: with no window
 * open there is nowhere to run it.
 */
export function runSetupScript(workspacePath: string, script: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  const command: AppCommand = {
    cmd: "run-setup-script",
    workspacePath,
    script,
  };
  win.webContents.send("app-command", command);
}

/**
 * Tell the renderer its project list is stale. Mutations that originate in the
 * renderer fold the result straight into the store, but ones that arrive over
 * the control server (MCP, `manor` CLI) have no such return path — without this
 * the sidebar keeps showing the pre-mutation list until something else refetches.
 */
export function notifyProjectsChanged(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  win.webContents.send("projects-changed");
}
