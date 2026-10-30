/**
 * How long a browser pane keeps retrying a dev server that isn't up yet: a
 * loopback page refused because nothing listens on its port is usually a
 * server still starting, so the pane waits for it instead of showing the
 * error page.
 */
import { ERR_CONNECTION_REFUSED } from "./browser-load-error";

/** The whole wait, from the first refusal; after it the error page shows. */
export const DEV_SERVER_WAIT_MS = 2 * 60_000;

/** The delay before each retry; every one after the last waits as long as it. */
const BACKOFF_MS = [1_000, 1_000, 2_000, 3_000, 5_000];

/**
 * Whether a main-frame load of `url` that failed with `errorCode` waits for
 * a dev server: only a refused `http://` load on this machine's loopback.
 */
export function waitsForDevServer(url: string, errorCode: number): boolean {
  return (
    errorCode === ERR_CONNECTION_REFUSED &&
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|\?|#|$)/i.test(url)
  );
}

/**
 * The delay before retry `attempt` (1 for the first), `elapsedMs` into the
 * wait; null once that retry would land past the end of the wait.
 */
export function retryDelay(attempt: number, elapsedMs: number): number | null {
  const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  return elapsedMs + delay > DEV_SERVER_WAIT_MS ? null : delay;
}
