/**
 * How long a browser pane keeps retrying a dev server that isn't up yet: a
 * loopback page refused because nothing listens on its port is usually a
 * server still starting, so the pane waits for it instead of showing the
 * error page.
 */
import {
  ERR_CONNECTION_CLOSED,
  ERR_CONNECTION_REFUSED,
  ERR_CONNECTION_RESET,
  ERR_EMPTY_RESPONSE,
} from "./browser-load-error";

/** The whole wait, from the first refusal; after it the error page shows. */
export const DEV_SERVER_WAIT_MS = 2 * 60_000;

/** The delay before each retry; every one after the last waits as long as it. */
const BACKOFF_MS = [1_000, 1_000, 2_000, 3_000, 5_000];

/**
 * How a load through a remote pane's port forward fails while nothing listens
 * on the box's port. The forward's own local port does listen, so the
 * connection is accepted, then closed or reset once the box refuses the other
 * end: an ssh `-L` forward drops the socket when its channel open fails, and
 * an exec forward's `port-pipe` exits and ends it.
 */
const FORWARD_REFUSED = new Set([
  ERR_CONNECTION_REFUSED,
  ERR_EMPTY_RESPONSE,
  ERR_CONNECTION_CLOSED,
  ERR_CONNECTION_RESET,
]);

/**
 * Whether a main-frame load of `url` that failed with `errorCode` waits for
 * a dev server: only a refused `http://` load on this machine's loopback. A
 * `remote` pane loads the box's dev servers through a port forward on that
 * loopback, so it also waits on the ways a forward says the box refused.
 */
export function waitsForDevServer(url: string, errorCode: number, remote = false): boolean {
  const refused = remote ? FORWARD_REFUSED.has(errorCode) : errorCode === ERR_CONNECTION_REFUSED;
  return refused && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|\?|#|$)/i.test(url);
}

/**
 * The delay before retry `attempt` (1 for the first), `elapsedMs` into the
 * wait; null once that retry would land past the end of the wait.
 */
export function retryDelay(attempt: number, elapsedMs: number): number | null {
  const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  return elapsedMs + delay > DEV_SERVER_WAIT_MS ? null : delay;
}
