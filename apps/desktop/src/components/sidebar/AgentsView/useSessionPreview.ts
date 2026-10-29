import { useEffect, useRef, useState } from "react";
import type { ModalRow } from "./agents-modal-list";
import { createPreviewLoader, previewIdentity, previewRef, type PreviewState } from "./session-preview";

const LOADING: PreviewState = { status: "loading" };

/** How often a live Agent's preview is asked for again while highlighted. */
const LIVE_REFRESH_MS = 5000;

/** The conversation a preview key names (see `useSessionPreview`). */
const identityOf = (key: string) => key.slice(0, key.indexOf("\0"));

/**
 * The highlighted row's conversation, loaded as `createPreviewLoader`
 * describes. A preview is cached per conversation for one opening of the
 * modal (reopening asks again, once), and a `live` row's is asked for again
 * every few seconds, so a working agent's preview keeps up. While a newer
 * copy of the shown conversation loads, the older one stays on screen.
 */
export function useSessionPreview(
  row: ModalRow | null,
  open: boolean,
  live: boolean,
): PreviewState {
  const [shown, setShown] = useState<{ key: string; state: PreviewState } | null>(null);
  const loaderRef = useRef<ReturnType<typeof createPreviewLoader> | null>(null);

  useEffect(() => {
    const loader = createPreviewLoader(
      (ref) => window.electronAPI.sessions.transcript(ref),
      (key, state) =>
        setShown((prev) =>
          state.status === "loading" &&
          prev?.state.status === "ready" &&
          identityOf(prev.key) === identityOf(key)
            ? prev
            : { key, state },
        ),
    );
    loaderRef.current = loader;
    return () => loader.dispose();
  }, []);

  // Each opening is a new generation; closing drops whatever is pending.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (open) setGeneration((g) => g + 1);
    else loaderRef.current?.dispose();
  }, [open]);

  const identity = row ? previewIdentity(row) : null;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open || !live || identity === null) return;
    const timer = setInterval(() => setTick((t) => t + 1), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, live, identity]);

  const key = identity === null ? null : `${identity}\0${generation}.${live ? tick : 0}`;
  const ref = row ? previewRef(row) : null;
  // The ref is derived from the row, which the key names.
  const refRef = useRef(ref);
  refRef.current = ref;
  useEffect(() => {
    if (!open || key === null) return;
    loaderRef.current?.show(key, refRef.current);
  }, [open, key]);

  if (!shown || key === null) return LOADING;
  if (shown.key === key) return shown.state;
  return shown.state.status === "ready" && identityOf(shown.key) === identityOf(key)
    ? shown.state
    : LOADING;
}
