import { create } from "zustand";

export interface Toast {
  id: string;
  message: string;
  status: "loading" | "success" | "error";
  detail?: string;
  persistent?: boolean;
  /** Custom auto-dismiss duration in ms (overrides default) */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Toast) => void;
  updateToast: (id: string, updates: Partial<Omit<Toast, "id">>) => void;
  removeToast: (id: string) => void;
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
