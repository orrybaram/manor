import { create } from "zustand";

export interface Toast {
  id: string;
  message: string;
  status: "loading" | "success" | "error";
  detail?: string;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Toast) => void;
  updateToast: (id: string, updates: Partial<Omit<Toast, "id">>) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) => set((s) => ({ toasts: [...s.toasts, toast] })),

  updateToast: (id, updates) =>
    set((s) => ({
      toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
