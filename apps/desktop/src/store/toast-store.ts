/**
 * The old toast API, as thin shims over `src/toast/`. Kept only until the
 * call sites move to `toast.*` (#428); nothing new should import this.
 *
 * `useToastStore` still answers `getState()`, `setState({ toasts })` and a
 * selector hook, in the old shape: `persistent` for what the module calls
 * `duration: "sticky"`.
 */
import { useStore } from "zustand";
import { toast, wasReported } from "../toast";
import {
  patchRecord,
  putRecord,
  removeRecord,
  replaceRecords,
  toastStore,
  type ToastRecord,
} from "../toast/toast-store";

export { wasReported };

export interface Toast {
  id: string;
  message: string;
  /** `info` is neutral: a question or notice, neither a result nor a failure. */
  status: "loading" | "success" | "error" | "info";
  detail?: string;
  persistent?: boolean;
  /** Custom auto-dismiss duration in ms (overrides default) */
  duration?: number;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  /** Called when the user closes a persistent toast with its X button. */
  onClose?: () => void;
  /** When true, render `detail` expanded on first mount instead of collapsed. */
  autoExpand?: boolean;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Toast) => void;
  updateToast: (id: string, updates: Partial<Omit<Toast, "id">>) => void;
  removeToast: (id: string) => void;
}

/**
 * Surface an error to the user as a toast — `toast.error(message, { id, error })`.
 */
export function addErrorToast(id: string, message: string, err: unknown): void {
  toast.error(message, { id, error: err });
}

function fromLegacy(t: Toast): ToastRecord {
  const { persistent, duration, ...rest } = t;
  const record: ToastRecord = { ...rest };
  if (persistent) record.duration = "sticky";
  else if (duration !== undefined) record.duration = duration;
  return record;
}

function toLegacy(r: ToastRecord): Toast {
  const t: Toast = {
    id: r.id,
    message: r.message,
    status: r.status,
  };
  if (r.detail !== undefined) t.detail = r.detail;
  if (r.duration === "sticky") t.persistent = true;
  else if (r.duration !== undefined) t.duration = r.duration;
  if (r.action) t.action = r.action;
  if (r.secondaryAction) t.secondaryAction = r.secondaryAction;
  if (r.onClose) t.onClose = r.onClose;
  if (r.autoExpand !== undefined) t.autoExpand = r.autoExpand;
  return t;
}

const addToast = (t: Toast) => putRecord(fromLegacy(t));

const updateToast = (id: string, updates: Partial<Omit<Toast, "id">>) => {
  const { persistent, duration, ...rest } = updates;
  const patch: Partial<Omit<ToastRecord, "id">> = { ...rest };
  if (persistent) patch.duration = "sticky";
  else if (duration !== undefined) patch.duration = duration;
  else if (persistent === false) patch.duration = undefined;
  patchRecord(id, patch);
};

const removeToast = (id: string) => removeRecord(id);

// One legacy state per records array, so a selector-less hook (or one
// selecting `toasts`) sees a stable snapshot between changes.
const views = new WeakMap<ToastRecord[], ToastState>();

function legacyState(records: ToastRecord[]): ToastState {
  let view = views.get(records);
  if (!view) {
    view = { toasts: records.map(toLegacy), addToast, updateToast, removeToast };
    views.set(records, view);
  }
  return view;
}

function useLegacyToastStore(): ToastState;
function useLegacyToastStore<T>(selector: (s: ToastState) => T): T;
function useLegacyToastStore<T>(selector?: (s: ToastState) => T): T | ToastState {
  return useStore(toastStore, (s) => {
    const state = legacyState(s.toasts);
    return selector ? selector(state) : state;
  });
}

export const useToastStore = Object.assign(useLegacyToastStore, {
  getState: (): ToastState => legacyState(toastStore.getState().toasts),
  /** Only `{ toasts }` means anything here: it replaces every toast. */
  setState: (partial: Partial<Pick<ToastState, "toasts">>): void => {
    if (partial.toasts) replaceRecords(partial.toasts.map(fromLegacy));
  },
});
