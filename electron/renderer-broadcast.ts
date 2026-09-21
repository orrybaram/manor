/**
 * Where main's pushes to its renderers go (ADR-178 D8, ADR-180 D5).
 *
 * The desktop renderer learned that its projects, preferences, keybindings,
 * agents, notifications or stats moved through `webContents.send` on one of a
 * handful of named channels. A browser renderer has no `webContents`, so the
 * bridge needs the same signal — and the rule this file exists to enforce is
 * that it is the *same* signal, not a second detector. Each send-site gains
 * one line next to the `webContents.send` it already had; nothing here decides
 * when a thing changed.
 *
 * ADR-180 D5 finishes the job: the bridge's IPC transport (D2) gives every
 * desktop window a connection, so `bridge/server.ts`'s sink reaches the
 * windows *and* the sockets, and a converted send-site keeps the publish and
 * drops the `webContents.send` rather than doing both. The comment above is
 * still the rule — it is now the only line at the send-site instead of the
 * second one.
 *
 * Electron-free on purpose, and a leaf: `notifications.ts`, `updater.ts`, the
 * watchers and `renderer-bridge.ts` publish into it, `bridge/server.ts`
 * subscribes, and neither has to import the other. That matters more than it
 * reads: `bridge/server.ts` imports the whole handler table, which imports
 * half of `electron/ipc/`, and a send-site that reached for the server
 * directly would close a cycle back onto itself.
 *
 * `ns`/`event` are the bridge's names for the channel, not Electron's:
 * `projects-changed` is `projects`/`changed`, `agent-updated` is
 * `agents`/`updated`. The renderer's `ns.onX(cb)` subscribes to them by the
 * same pair, so the two halves are readable together.
 *
 * ADR-179 adds `layout`/`changed`, published by `LayoutStore` through the
 * broadcaster `app-lifecycle.ts` hands it — the one signal that carries state
 * a renderer must *replace* rather than merely refresh.
 */

export interface RendererBroadcast {
  ns: string;
  event: string;
  args: unknown[];
  /**
   * The one connection this is for, or null for everyone (ADR-180 D5).
   *
   * Broadcast is the common case and the honest default: `projects.changed`
   * is about the machine. A handful of pushes are not — `app-command` goes to
   * the primary window, `menu.command` to the focused one, a worktree's setup
   * progress to whoever asked for the worktree — and a broadcast cannot say
   * that. The id is a bridge connection id, which for a desktop window is its
   * `webContents.id` as a string (`bridge/transports/ipc.ts`).
   */
  to: string | null;
}

type Sink = (broadcast: RendererBroadcast) => void;

const sinks = new Set<Sink>();

/**
 * How a renderer window becomes a connection id.
 *
 * Registered by the IPC transport, which is the only thing that knows which
 * windows have live connections — connection-to-window is the transport's
 * private business (ADR-180 D5), and this is the hole it plugs itself into so
 * that `app-menu.ts` and friends can address a window without importing the
 * bridge server through it.
 */
type WindowResolver = (win: RendererWindowLike) => string | null;

/** The little of a `BrowserWindow` resolution needs. Keeps this file a leaf. */
export interface RendererWindowLike {
  webContents: { id: number };
}

let windowResolver: WindowResolver | null = null;

/** Install the resolver. The transport calls this on `start()` and undoes it. */
export function setRendererWindowResolver(
  resolver: WindowResolver | null,
): void {
  windowResolver = resolver;
}

/**
 * That window's connection id, or null if it has none — no transport yet, a
 * window that has never spoken a frame, or one that is not ours at all.
 *
 * Null means "nobody is listening", which is a real answer: `requestRenderer`
 * turns it into the 503 it used to return when no window was open.
 */
export function connectionIdForWindow(
  win: RendererWindowLike | null | undefined,
): string | null {
  if (!win || !windowResolver) return null;
  try {
    return windowResolver(win);
  } catch {
    return null;
  }
}

/** Register a sink. Returns the unsubscribe; call it when the sink dies. */
export function addRendererBroadcastSink(sink: Sink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/**
 * Fan one broadcast out to every sink. Never throws: this runs on paths that
 * must not fail, and a sink that throws is that sink's bug, not the sender's.
 */
export function publishRendererBroadcast(
  ns: string,
  event: string,
  ...args: unknown[]
): void {
  emit(null, ns, event, args);
}

/**
 * The same, for one connection only (ADR-180 D5) — or for everyone, when
 * there is no one connection to address.
 *
 * `connectionId` comes either from `connectionIdForWindow` above or from the
 * caller that asked for the thing this reports on (a bridge handler's
 * `ctx.caller.id`). Null is the callers with no connection behind them — the
 * CLI, MCP, the issue-batch path — and broadcasts.
 */
export function publishToRenderer(
  connectionId: string | null,
  ns: string,
  event: string,
  ...args: unknown[]
): void {
  emit(connectionId, ns, event, args);
}

function emit(
  to: string | null,
  ns: string,
  event: string,
  args: unknown[],
): void {
  if (sinks.size === 0) return;
  for (const sink of sinks) {
    try {
      sink({ ns, event, args, to });
    } catch (err) {
      console.error("[renderer-broadcast] sink threw:", err);
    }
  }
}
