import { create } from "zustand";
import { ipcErrorMessage } from "../lib/ipc-error";

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
 * Surface an error to the user as a toast. Normalizes `unknown` to a string
 * detail without Electron's IPC wrapper (`ipcErrorMessage`) — the shape every
 * catch block was hand-rolling. Pass a stable `id` so a repeated failure replaces its toast
 * rather than stacking (see `addToast`'s dedupe).
 */
export function addErrorToast(id: string, message: string, err: unknown): void {
  markReported(err);
  useToastStore.getState().addToast({
    id,
    message,
    status: "error",
    detail: ipcErrorMessage(err),
  });
}

// Errors `addErrorToast` already showed, so a rethrow that goes on to reject
// unhandled doesn't toast a second time.
const reported = new WeakSet<object>();

function markReported(err: unknown): void {
  if (typeof err === "object" && err !== null) reported.add(err);
}

/** Whether `err` already reached the user through `addErrorToast`. */
export function wasReported(err: unknown): boolean {
  return typeof err === "object" && err !== null && reported.has(err);
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) =>
    set((s) => {
      // Deduplicate by id — replace existing toast instead of appending
      const exists = s.toasts.some((t) => t.id === toast.id);
      if (exists) {
        return { toasts: s.toasts.map((t) => (t.id === toast.id ? toast : t)) };
      }
      return { toasts: [...s.toasts, toast] };
    }),

  updateToast: (id, updates) =>
    set((s) => ({
      toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
