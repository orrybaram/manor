import { publishRendererBroadcast } from "../../renderer-broadcast";
import { BROADCAST_DEBOUNCE_MS } from "./stats";
import type { IpcDeps } from "../../ipc/types";

/**
 * ADR-199's Agent activity surface, on the handler table (ADR-180 D8).
 * `agentActivityStore` is main's single source of truth; the renderer only
 * caches the snapshot broadcast here.
 */
export function agentActivityGet(deps: IpcDeps): unknown {
  return deps.agentActivityStore.getSnapshot();
}

/**
 * Wire the debounced `agentActivity.changed` broadcast, once, at boot.
 *
 * Busy agents change status many times a minute, so the subscription is
 * debounced the same way `stats.changed` is (`wireStatsBroadcast`).
 */
export function wireAgentActivityBroadcast(
  deps: Pick<IpcDeps, "agentActivityStore">,
): void {
  const { agentActivityStore } = deps;
  let timer: ReturnType<typeof setTimeout> | null = null;
  agentActivityStore.onChange(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      publishRendererBroadcast(
        "agentActivity",
        "changed",
        agentActivityStore.getSnapshot(),
      );
    }, BROADCAST_DEBOUNCE_MS);
  });
}
