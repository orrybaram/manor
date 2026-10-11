/**
 * The manual refresh (ADR-220 D5), reachable from components.
 *
 * `install-web.ts` installs `window.electronAPI` as a side effect of being
 * imported, so a component shared with the desktop cannot import it. It
 * registers `refreshBridge` here instead; on the desktop nothing registers
 * and a refresh is a no-op.
 */

let refresher: (() => Promise<void>) | null = null;

/** Called by `install-web.ts` with the real refresh. */
export function registerRefresh(fn: () => Promise<void>): void {
  refresher = fn;
}

/** Refresh the bridge's state; resolves when it settles. */
export async function refreshState(): Promise<void> {
  await refresher?.();
}
