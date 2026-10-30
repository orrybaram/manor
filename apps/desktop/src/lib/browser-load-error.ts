/**
 * What a browser pane's error page says about a failed load: Chromium's
 * net error name (`ERR_NAME_NOT_RESOLVED`, as `did-fail-load` reports it)
 * in a sentence.
 */

/** Chromium's code for a load cut short by another (a new navigation, Stop). */
export const ERR_ABORTED = -3;
/** Nothing is listening on the port. */
export const ERR_CONNECTION_REFUSED = -102;

const DESCRIPTIONS: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: "The server's DNS address could not be found.",
  ERR_NAME_RESOLUTION_FAILED: "The server's DNS address could not be found.",
  ERR_CONNECTION_REFUSED: "The server refused the connection.",
  ERR_CONNECTION_RESET: "The connection was reset.",
  ERR_CONNECTION_CLOSED: "The server closed the connection.",
  ERR_EMPTY_RESPONSE: "The server closed the connection without sending anything.",
  ERR_CONNECTION_TIMED_OUT: "The server took too long to respond.",
  ERR_TIMED_OUT: "The server took too long to respond.",
  ERR_ADDRESS_UNREACHABLE: "The server's address can't be reached.",
  ERR_INTERNET_DISCONNECTED: "This computer isn't connected to the internet.",
  ERR_NETWORK_CHANGED: "The network changed while the page was loading.",
  ERR_TOO_MANY_REDIRECTS: "The page redirected too many times.",
  ERR_SSL_PROTOCOL_ERROR: "The site sent an invalid response over a secure connection.",
  ERR_UNSAFE_PORT: "Browsers don't load pages from this port.",
  ERR_FILE_NOT_FOUND: "The file couldn't be found.",
  ERR_INVALID_URL: "The address isn't valid.",
  ERR_BLOCKED_BY_CLIENT: "The page was blocked.",
  ERR_BLOCKED_BY_RESPONSE: "The site doesn't allow itself to be shown here.",
};

/** A sentence for the error page, for any `ERR_*` name. */
export function describeLoadError(name: string): string {
  const known = DESCRIPTIONS[name];
  if (known) return known;
  if (name.startsWith("ERR_CERT_")) return "The site's security certificate isn't trusted.";
  return "Something went wrong loading the page.";
}
