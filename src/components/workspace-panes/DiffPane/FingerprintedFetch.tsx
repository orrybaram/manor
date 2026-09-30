import { useMountEffect } from "../../../hooks/useMountEffect";
import { watchDiffFingerprint } from "../../../lib/diff-fingerprints";
import type { WorkspaceKey } from "../../../lib/workspace-key";

type FingerprintedFetchProps<T> = {
  /** The workspace whose diff fingerprint re-triggers the fetch. */
  wsKey: WorkspaceKey;
  fetch: () => Promise<T>;
  onResult: (result: T) => void;
  onError?: (err: unknown) => void;
};

/**
 * Runs `fetch` once on mount and again each time `wsKey`'s diff fingerprint
 * moves — never on a timer, so a pane over an unchanged workspace runs no
 * git. Renders nothing. Give it a `key` naming what it fetches: a change of
 * workspace, mode or branch then starts a fresh one, and a result for the old
 * one is dropped.
 */
export function FingerprintedFetch<T>({
  wsKey,
  fetch,
  onResult,
  onError,
}: FingerprintedFetchProps<T>) {
  useMountEffect(() => {
    let cancelled = false;
    const run = () => {
      fetch().then(
        (result) => {
          if (!cancelled) onResult(result);
        },
        (err: unknown) => {
          if (!cancelled) onError?.(err);
        },
      );
    };
    run();
    const unwatch = watchDiffFingerprint(wsKey, run);
    return () => {
      cancelled = true;
      unwatch();
    };
  });
  return null;
}
