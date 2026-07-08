/**
 * A ~40-line path matcher, replacing the positional `segments[0] === "panes"`
 * dispatch that `handleControlRequest` used to hand-roll.
 *
 * The three exit paths are the whole design, and each maps to behaviour the old
 * code spelled out by hand at every route:
 *
 *   1. path + method match  → run the handler, `true`.
 *   2. path matches, method does not → one `405`, `true`. Collecting the
 *      path-matches first is what let the 13 hand-written 405 branches go.
 *   3. nothing matches → `404` if the first segment is a prefix this module
 *      owns, otherwise `false` so the HTTP listener can try its own routes
 *      (`/webviews`, `/webview/:id/*`). The `false` is load-bearing.
 *
 * Route order matters only between two rows that share both a method and a
 * segment count, where one row's static segment is the other's `:param` —
 * in every other case (different method, different segment count, or no
 * overlapping segment) the two can never both match the same request, so
 * their relative order is inert. `router.test.ts` asserts this holds over
 * the real route table.
 */

import type { ControlDeps, Json, ReadBody, Route } from "./types";

/**
 * Match one pattern against an already-split request path. Segment counts must
 * be equal — no prefix matching, no trailing-slash tolerance, exactly what the
 * old `segments.length === 3` guards enforced.
 *
 * `decodeURIComponent` happens here and only here: static segments compare raw
 * (as they always did), captured ones are decoded once for the handler.
 */
export function matchPath(
  pattern: string,
  segments: string[],
): Record<string, string> | null {
  const parts = pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith(":"))
      params[part.slice(1)] = decodeURIComponent(segments[i]);
    else if (part !== segments[i]) return null;
  }
  return params;
}

/**
 * Walk `routes` in order and run the first whose path *and* method match.
 *
 * Order is significance: a static segment must precede the `:param` that would
 * also swallow it (`/panes/split` before `/panes/:paneId`). Note the
 * method-mismatch `continue` rather than a bail — `DELETE /panes/split` has to
 * fall past the POST-only `/panes/split` row onto `/panes/:paneId`, closing the
 * pane literally named "split", which is what the old code did.
 *
 * @param ownedPrefixes first segments this module answers for. A request under
 *   one of them that matches no route is a `404`, not a fall-through — the
 *   caller must not go looking for a webview route named `/projects/...`.
 */
export async function dispatch(
  routes: readonly Route[],
  ownedPrefixes: ReadonlySet<string>,
  deps: ControlDeps,
  method: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);

  let pathMatched = false;
  for (const route of routes) {
    const params = matchPath(route.path, segments);
    if (!params) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    await route.handler({ deps, params, url, json, readBody });
    return true;
  }

  if (pathMatched) {
    json(405, { error: "Method not allowed" });
    return true;
  }

  if (segments.length > 0 && ownedPrefixes.has(segments[0])) {
    json(404, { error: "Not found" });
    return true;
  }

  return false;
}
