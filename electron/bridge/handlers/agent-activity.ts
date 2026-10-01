import { publishRendererBroadcast } from "../../renderer-broadcast";
import { BROADCAST_DEBOUNCE_MS } from "./stats";
import type { HostDeps } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";
import type { AgentActivitySnapshot } from "../../agent-activity-store";

/**
 * ADR-199's Agent activity surface, one namespace table (ADR-182 D3).
 * `agentActivityStore` is main's single source of truth; the renderer only
 * caches the snapshot broadcast here.
 */
export function agentActivityGet(ctx: HandlerCtx): AgentActivitySnapshot {
  return ctx.deps.agentActivityStore.getSnapshot();
}

/**
 * Wire the debounced `agentActivity.changed` broadcast, once, at boot.
 *
 * Busy agents change status many times a minute, so the subscription is
 * debounced the same way `stats.changed` is (`wireStatsBroadcast`).
 */
export function wireAgentActivityBroadcast(
  deps: Pick<HostDeps, "agentActivityStore">,
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

/** A read; its pushes are `agentActivity.changed`. */
export const agentActivity = {
  get: method(agentActivityGet),
};
