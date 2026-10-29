/**
 * What a tapped push tells the page: `sw.ts` keeps a push's ids on its
 * notification and, on a tap, posts the message this builds to the tab it
 * focuses; `open-agent.ts` reads it back. Free of the app's modules, since the
 * service worker bundles it.
 */

/** The ids a push carries, kept on its notification for the tap. */
export interface PushClickData {
  agentId?: string;
  automationId?: string;
  /** With `automationId`: the host keeping it, as the page knows it. */
  hostId?: string;
}

export type PushClickMessage =
  | { type: "open-agent"; agentId: string }
  | { type: "open-automation"; automationId: string; hostId?: string };

/** The message for a tapped notification's data, or null: just focus the app. */
export function pushClickMessage(data: unknown): PushClickMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.agentId === "string" && d.agentId) {
    return { type: "open-agent", agentId: d.agentId };
  }
  if (typeof d.automationId === "string" && d.automationId) {
    return {
      type: "open-automation",
      automationId: d.automationId,
      ...(typeof d.hostId === "string" && d.hostId ? { hostId: d.hostId } : {}),
    };
  }
  return null;
}

/** A message the page heard, if it is the worker's tap message; else null. */
export function readPushClickMessage(data: unknown): PushClickMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = pushClickMessage(data);
  return message && message.type === (data as { type?: unknown }).type ? message : null;
}
