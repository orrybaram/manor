import { useEffect, useRef, useState } from "react";
import type { ModalRow } from "./agents-modal-list";
import { createPreviewLoader, previewKey, previewRef, type PreviewState } from "./session-preview";

const LOADING: PreviewState = { status: "loading" };

/** The row id a `previewKey` names. */
const rowOf = (key: string) => key.slice(0, key.lastIndexOf("@"));

/**
 * The highlighted row's conversation, loaded as `createPreviewLoader`
 * describes. The cache lives as long as the modal component does, so
 * reopening the modal on a row seen before is instant too.
 */
export function useSessionPreview(row: ModalRow | null, open: boolean): PreviewState {
  const [shown, setShown] = useState<{ key: string; state: PreviewState } | null>(null);
  const loaderRef = useRef<ReturnType<typeof createPreviewLoader> | null>(null);

  useEffect(() => {
    const loader = createPreviewLoader(
      (ref) => window.electronAPI.sessions.transcript(ref),
      // A row whose transcript moved on keeps its old conversation on
      // screen while the new one loads.
      (key, state) =>
        setShown((prev) =>
          state.status === "loading" &&
          prev?.state.status === "ready" &&
          rowOf(prev.key) === rowOf(key)
            ? prev
            : { key, state },
        ),
    );
    loaderRef.current = loader;
    return () => loader.dispose();
  }, []);

  const key = row ? previewKey(row) : null;
  const ref = row ? previewRef(row) : null;
  // The ref is derived from the row, which the key names.
  const refRef = useRef(ref);
  refRef.current = ref;
  useEffect(() => {
    if (!open || key === null) return;
    loaderRef.current?.show(key, refRef.current);
  }, [open, key]);

  // Until the loader answers for this row, it is loading.
  if (!shown || key === null) return LOADING;
  if (shown.key === key) return shown.state;
  return shown.state.status === "ready" && rowOf(shown.key) === rowOf(key) ? shown.state : LOADING;
}
