/**
 * ADR-178's one platform check.
 *
 * `window.electronAPI` has exactly two implementations (D8): the preload
 * bridge, whose `platform` is `"electron"`, and `createWsBridge` (ticket 4),
 * whose `platform` is always `"web"`. Every "this is Electron-only" branch in
 * the renderer should read this rather than sniff `navigator.userAgent` (a
 * browser fact, not a bridge fact) or wrap a bridge call in `try/catch` (which
 * only tells you a call failed, not why, and runs the call before finding
 * out). `isWebApp()` answers the question before anything is invoked.
 */
export function isWebApp(): boolean {
  return typeof window !== "undefined" && window.electronAPI?.platform === "web";
}
