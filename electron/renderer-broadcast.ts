/**
 * A second sink for the pushes main already makes to its renderer windows
 * (ADR-178 D8).
 *
 * The desktop renderer learns that its projects, preferences, keybindings,
 * agents, notifications or stats moved through `webContents.send` on one of a
 * handful of named channels. A browser renderer has no `webContents`, so the
 * bridge needs the same signal — and the rule this file exists to enforce is
 * that it is the *same* signal, not a second detector. Each send-site gains
 * one line next to the `webContents.send` it already had; nothing here decides
 * when a thing changed.
 *
 * Electron-free on purpose, and a leaf: `notifications.ts` and
 * `renderer-bridge.ts` publish into it, `remote-control/ws-bridge-server.ts`
 * subscribes, and neither has to import the other.
 *
 * `ns`/`event` are the bridge's names for the channel, not Electron's:
 * `projects-changed` is `projects`/`changed`, `agent-updated` is
 * `agents`/`updated`. The renderer's `ns.onX(cb)` subscribes to them by the
 * same pair, so the two halves are readable together.
 */

export interface RendererBroadcast {
  ns: string;
  event: string;
  args: unknown[];
}

type Sink = (broadcast: RendererBroadcast) => void;

const sinks = new Set<Sink>();

/** Register a sink. Returns the unsubscribe; call it when the sink dies. */
export function addRendererBroadcastSink(sink: Sink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/**
 * Fan one broadcast out to every sink. Never throws: this runs beside a
 * `webContents.send` on paths that must not fail, and a sink that throws is
 * that sink's bug, not the sender's.
 */
export function publishRendererBroadcast(
  ns: string,
  event: string,
  ...args: unknown[]
): void {
  if (sinks.size === 0) return;
  for (const sink of sinks) {
    try {
      sink({ ns, event, args });
    } catch (err) {
      console.error("[renderer-broadcast] sink threw:", err);
    }
  }
}
