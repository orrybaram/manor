import type { SessionPreview, SessionRef } from "../../../electron.d";
import { sessionIdentity, type ModalRow } from "./agents-modal-list";

/**
 * Which transcript a row previews: its Session's, else its Agent's own
 * transcript when the Agent knows one; null when there is none to read.
 */
export function previewRef(row: ModalRow): SessionRef | null {
  const { session, agent } = row;
  if (session) {
    return { hostId: session.hostId, kind: session.kind, sessionId: session.sessionId, path: session.path };
  }
  if (agent?.transcriptPath && agent.agentKind) {
    return {
      hostId: agent.hostId,
      kind: agent.agentKind,
      sessionId: agent.agentSessionId,
      path: agent.transcriptPath,
    };
  }
  return null;
}

/**
 * Which conversation a row shows, the same before and after its Session
 * joins it: an Agent and its Session share `kind:sessionId`. Status changes
 * don't touch it.
 */
export function previewIdentity(row: ModalRow): string {
  return sessionIdentity(row) ?? row.id;
}

/** A map that keeps only its `max` most recently used entries. */
export function createLru<V>(max: number): {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
} {
  const map = new Map<string, V>();
  return {
    get(key) {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
  };
}

/** What the preview pane shows for the highlighted row. */
export type PreviewState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; preview: SessionPreview }
  | { status: "error" };

/** How long the highlight must rest on a row before its transcript is asked for. */
const PREVIEW_DEBOUNCE_MS = 120;
const PREVIEW_CACHE_SIZE = 30;

/**
 * Loads previews as the highlight moves: a cached one shows at once; others
 * are asked for once the highlight rests, and only the newest answer is
 * handed on, so arrowing fast never shows an older row's conversation.
 * Failures aren't cached, so coming back to a row asks again.
 */
export function createPreviewLoader(
  fetch: (ref: SessionRef) => Promise<SessionPreview>,
  onState: (key: string, state: PreviewState) => void,
  opts: { debounceMs?: number; cacheSize?: number } = {},
): { show: (key: string, ref: SessionRef | null) => void; dispose: () => void } {
  const cache = createLru<SessionPreview>(opts.cacheSize ?? PREVIEW_CACHE_SIZE);
  const debounceMs = opts.debounceMs ?? PREVIEW_DEBOUNCE_MS;
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    show(key, ref) {
      const id = ++latest;
      cancel();
      if (!ref) {
        onState(key, { status: "none" });
        return;
      }
      const cached = cache.get(key);
      if (cached) {
        onState(key, { status: "ready", preview: cached });
        return;
      }
      onState(key, { status: "loading" });
      timer = setTimeout(() => {
        fetch(ref)
          .then((preview) => {
            cache.set(key, preview);
            if (id === latest) onState(key, { status: "ready", preview });
          })
          .catch(() => {
            if (id === latest) onState(key, { status: "error" });
          });
      }, debounceMs);
    },
    // Drops a pending ask and any answer still on its way; the loader
    // stays usable.
    dispose() {
      latest++;
      cancel();
    },
  };
}
