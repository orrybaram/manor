/**
 * Toasts: short notices bottom-right that go away on their own.
 *
 * ```ts
 * toast.success("Copied");
 * toast.error("Couldn't save", { error: err });
 * const p = toast.progress("Cloning…");
 * p.succeed("Cloned");          // or p.fail("Clone failed", err)
 * ```
 *
 * A stable `id` dedupes: showing a toast with an id already on screen
 * replaces it. Countdowns are 3s (errors 6s), held while the pointer is over
 * the stack or the window is unfocused; `duration: "sticky"` never runs out
 * and gets an X instead.
 */
import { useStore } from "zustand";
import { ipcErrorMessage } from "../lib/ipc-error";
import {
  hasRecord,
  patchRecord,
  putRecord,
  removeRecord,
  setStackHovered,
  toastStore,
  type ToastAction,
  type ToastRecord,
  type ToastStatus,
  type ToastSubject,
  type SubjectWatch,
} from "./toast-store";

export type { SubjectWatch, ToastAction, ToastRecord, ToastStatus, ToastSubject };
export { AUTO_DISMISS_MS, EXIT_MS } from "./toast-store";

/** The toasts on screen, oldest first — what `ToastContainer` renders. */
export function useToasts(): ToastRecord[] {
  return useStore(toastStore, (s) => s.toasts);
}

/**
 * Tell the toasts what is on screen, so a toast `about` a subject the user
 * is already looking at never appears, and retracts once they get there.
 * The app layer registers this once (`store/toast-subjects.ts`).
 */
export { watchSubjects as watchToastSubjects } from "./toast-store";

/** The pointer entered (true) or left (false) the toast stack: holds every countdown. */
export const setToastStackHovered = setStackHovered;

export interface ToastOptions {
  /** A stable id dedupes: a toast with an id already showing replaces it. */
  id?: string;
  detail?: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
  /** ms before it goes on its own; "sticky" never does, and shows an X. */
  duration?: number | "sticky";
  /** Called when the user closes it with its X. */
  onClose?: () => void;
  /** Show `detail` expanded from the start. */
  autoExpand?: boolean;
  /**
   * What it is about: while that is on screen (in any window) the toast
   * never appears, and once it gets there the toast retracts.
   */
  about?: ToastSubject;
}

export type ToastErrorOptions = ToastOptions & {
  /** The failure; its message becomes `detail` when none is given. */
  error?: unknown;
};

/** What a toast update may change: any option but its id, and its message. */
export type ToastPatch = Partial<Omit<ToastOptions, "id">> & { message?: string };

export interface ToastHandle {
  id: string;
  update(patch: ToastPatch): void;
  dismiss(): void;
}

export interface ProgressHandle extends ToastHandle {
  /**
   * Settle as a success: same slot, new toast, countdown starts now. A no-op
   * once the toast is gone — the user closed it, or its subject came on
   * screen: a success is not news worth bringing it back for.
   */
  succeed(message: string, opts?: Omit<ToastOptions, "id">): void;
  /**
   * Settle as a failure; `error` becomes the detail and counts as reported.
   * Shows even after the toast was closed: a failure is news.
   */
  fail(message: string, error?: unknown, opts?: Omit<ToastOptions, "id">): void;
}

let nextId = 0;

function record(
  status: ToastStatus,
  message: string,
  opts: ToastOptions | undefined,
  id: string,
): ToastRecord {
  const rest = { ...opts };
  delete rest.id;
  return { ...rest, id, message, status };
}

function handle(id: string): ToastHandle {
  return {
    id,
    update: (patch) => patchRecord(id, patch),
    dismiss: () => removeRecord(id),
  };
}

function show(status: ToastStatus, message: string, opts?: ToastOptions): ToastHandle {
  const id = opts?.id ?? `toast-${++nextId}`;
  putRecord(record(status, message, opts, id));
  return handle(id);
}

// Errors already shown as a toast, so a rethrow that goes on to reject
// unhandled doesn't toast a second time.
const reported = new WeakSet<object>();

function markReported(err: unknown): void {
  if (typeof err === "object" && err !== null) reported.add(err);
}

/** Whether `err` already reached the user as an error toast. */
export function wasReported(err: unknown): boolean {
  return typeof err === "object" && err !== null && reported.has(err);
}

function errorOptions(opts: ToastErrorOptions | undefined): ToastOptions | undefined {
  if (!opts) return opts;
  const { error, ...rest } = opts;
  if (error === undefined) return rest;
  markReported(error);
  return { ...rest, detail: rest.detail ?? ipcErrorMessage(error) };
}

export const toast = {
  info: (message: string, opts?: ToastOptions): ToastHandle => show("info", message, opts),

  success: (message: string, opts?: ToastOptions): ToastHandle =>
    show("success", message, opts),

  /**
   * A failure. `error` is normalised into `detail` (Electron's IPC wrapper
   * stripped) unless a detail is given, and marked reported (`wasReported`).
   */
  error: (message: string, opts?: ToastErrorOptions): ToastHandle =>
    show("error", message, errorOptions(opts)),

  /** A spinner with no countdown until it settles with `succeed` or `fail`. */
  progress: (message: string, opts?: ToastOptions): ProgressHandle => {
    const shown = show("loading", message, opts);
    const about = opts?.about;
    const settle = (status: ToastStatus, text: string, settled?: ToastOptions) =>
      putRecord(record(status, text, { about, ...settled }, shown.id));
    return {
      ...shown,
      succeed: (text, settled) => {
        if (hasRecord(shown.id)) settle("success", text, settled);
      },
      fail: (text, error, settled) =>
        settle("error", text, errorOptions({ ...settled, error })),
    };
  },

  dismiss: (id: string): void => removeRecord(id),
};
