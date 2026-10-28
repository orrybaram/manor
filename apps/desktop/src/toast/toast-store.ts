/**
 * The toasts on screen and their countdowns. Private to `src/toast/`:
 * everything outside reaches it through `toast.*` (`./index.ts`), except the
 * legacy `store/toast-store.ts` shims, which go away with the migration.
 *
 * Countdowns live here, not in the component, so they can be held: every
 * toast keeps its *remaining* time, and while the stack is hovered or the
 * window is unfocused none of them runs. Releasing the hold continues each
 * from where it stopped.
 */
import { createStore } from "zustand/vanilla";
import { isWindowFocused, onWindowFocusChange } from "../lib/window-focus";

export type ToastStatus = "loading" | "success" | "error" | "info";

/** What a toast is about. Stored only, for now; #430 retracts on it. */
export type ToastSubject = { agent: string } | { pane: string } | { workspace: string };

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastRecord {
  id: string;
  message: string;
  /** `info` is neutral: a question or notice, neither a result nor a failure. */
  status: ToastStatus;
  detail?: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
  /** ms before it goes; "sticky" never goes on its own and shows an X. */
  duration?: number | "sticky";
  /** Called when the user closes it with its X button. */
  onClose?: () => void;
  /** Render `detail` expanded on first mount instead of collapsed. */
  autoExpand?: boolean;
  about?: ToastSubject;
  /** Its countdown ran out: the component plays its exit, then it is removed. */
  leaving?: boolean;
}

export const AUTO_DISMISS_MS = 3000;
export const ERROR_DISMISS_MS = AUTO_DISMISS_MS * 2;
/** How long the exit animation plays before the toast is removed. */
export const EXIT_MS = 200;

export const toastStore = createStore<{ toasts: ToastRecord[] }>(() => ({
  toasts: [],
}));

interface Countdown {
  remaining: number;
  /** When it last started running; null while held. */
  startedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const countdowns = new Map<string, Countdown>();
const exits = new Map<string, ReturnType<typeof setTimeout>>();

let stackHovered = false;
let focusWired = false;

function held(): boolean {
  return stackHovered || !isWindowFocused();
}

/** How long `record` stays up; null for one with no countdown. */
function durationOf(record: ToastRecord): number | null {
  if (record.status === "loading") return null;
  if (record.duration === "sticky") return null;
  if (typeof record.duration === "number") return record.duration;
  return record.status === "error" ? ERROR_DISMISS_MS : AUTO_DISMISS_MS;
}

function run(id: string, countdown: Countdown): void {
  countdown.startedAt = Date.now();
  countdown.timer = setTimeout(() => {
    countdowns.delete(id);
    leave(id);
  }, countdown.remaining);
}

function hold(countdown: Countdown): void {
  if (countdown.startedAt === null) return;
  if (countdown.timer) clearTimeout(countdown.timer);
  countdown.remaining = Math.max(0, countdown.remaining - (Date.now() - countdown.startedAt));
  countdown.startedAt = null;
  countdown.timer = null;
}

function stopCountdown(id: string): void {
  const countdown = countdowns.get(id);
  if (countdown?.timer) clearTimeout(countdown.timer);
  countdowns.delete(id);
}

function stopExit(id: string): void {
  const exit = exits.get(id);
  if (exit) clearTimeout(exit);
  exits.delete(id);
}

/** (Re)start `record`'s countdown from its full duration. */
function startCountdown(record: ToastRecord): void {
  stopCountdown(record.id);
  const ms = durationOf(record);
  if (ms === null) return;
  wireFocus();
  const countdown: Countdown = { remaining: ms, startedAt: null, timer: null };
  countdowns.set(record.id, countdown);
  if (!held()) run(record.id, countdown);
}

function applyHold(): void {
  const isHeld = held();
  for (const [id, countdown] of countdowns) {
    if (isHeld) hold(countdown);
    else if (countdown.startedAt === null) run(id, countdown);
  }
}

function wireFocus(): void {
  if (focusWired) return;
  focusWired = true;
  onWindowFocusChange(applyHold);
}

/** The countdown ran out: mark it leaving, remove it once the exit has played. */
function leave(id: string): void {
  toastStore.setState((s) => ({
    toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
  }));
  stopExit(id);
  exits.set(
    id,
    setTimeout(() => {
      exits.delete(id);
      removeRecord(id);
    }, EXIT_MS),
  );
}

/** Show `record`, replacing any toast with its id (and restarting its countdown). */
export function putRecord(record: ToastRecord): void {
  stopExit(record.id);
  const next: ToastRecord = { ...record };
  delete next.leaving;
  toastStore.setState((s) => {
    const exists = s.toasts.some((t) => t.id === record.id);
    return {
      toasts: exists
        ? s.toasts.map((t) => (t.id === record.id ? next : t))
        : [...s.toasts, next],
    };
  });
  startCountdown(next);
}

/**
 * Change a showing toast. Its countdown restarts only when what decides it —
 * status or duration — changed; a new message alone keeps the time it had.
 */
export function patchRecord(id: string, patch: Partial<Omit<ToastRecord, "id">>): void {
  const current = toastStore.getState().toasts.find((t) => t.id === id);
  if (!current) return;
  const next: ToastRecord = { ...current, ...patch, id };
  const retimed = next.status !== current.status || next.duration !== current.duration;
  if (retimed) {
    // A toast on its way out that turns into something else stays.
    stopExit(id);
    delete next.leaving;
  }
  toastStore.setState((s) => ({
    toasts: s.toasts.map((t) => (t.id === id ? next : t)),
  }));
  if (retimed) startCountdown(next);
}

/** Remove a toast now — no exit animation, no countdown left behind. */
export function removeRecord(id: string): void {
  stopCountdown(id);
  stopExit(id);
  toastStore.setState((s) => {
    if (!s.toasts.some((t) => t.id === id)) return s;
    return { toasts: s.toasts.filter((t) => t.id !== id) };
  });
  // The stack is gone from under the pointer, and no `mouseleave` says so.
  if (toastStore.getState().toasts.length === 0) stackHovered = false;
}

/** Replace every toast — what the legacy `setState({ toasts })` did. */
export function replaceRecords(records: ToastRecord[]): void {
  for (const id of [...countdowns.keys()]) stopCountdown(id);
  for (const id of [...exits.keys()]) stopExit(id);
  toastStore.setState({ toasts: [] });
  stackHovered = false;
  for (const record of records) putRecord(record);
}

/** The pointer is over the toast stack (true) or has left it (false). */
export function setStackHovered(hovered: boolean): void {
  if (hovered === stackHovered) return;
  stackHovered = hovered;
  applyHold();
}
