import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setToastStackHovered, toast, wasReported } from "..";
import { toastStore } from "../toast-store";
import { addErrorToast, useToastStore } from "../../store/toast-store";

// Main's view of this window's focus, driven by the test: the desktop path of
// `lib/window-focus.ts`, which starts on the first countdown.
let pushFocus: (focused: boolean) => void = () => {};

beforeAll(() => {
  const api = window.electronAPI as unknown as Record<string, unknown>;
  api.platform = "electron";
  api.window = {
    isFocused: vi.fn().mockResolvedValue(true),
    onFocusChanged: (cb: (focused: boolean) => void) => {
      pushFocus = cb;
      return () => {};
    },
  };
});

const toasts = () => toastStore.getState().toasts;
const only = () => {
  expect(toasts()).toHaveLength(1);
  return toasts()[0];
};

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
  setToastStackHovered(false);
  pushFocus(true);
});

afterEach(() => {
  useToastStore.setState({ toasts: [] });
  vi.useRealTimers();
});

describe("toast", () => {
  it("replaces a toast with the same id instead of stacking", () => {
    toast.info("Working", { id: "job" });
    toast.success("Done", { id: "job" });
    expect(only()).toMatchObject({ id: "job", message: "Done", status: "success" });
  });

  it("gives each toast without an id its own", () => {
    const a = toast.info("a");
    const b = toast.info("b");
    expect(a.id).not.toBe(b.id);
    expect(toasts()).toHaveLength(2);
  });

  it("plays the exit, then removes, after 3s (errors 6s)", () => {
    toast.info("hi", { id: "info" });
    toast.error("bad", { id: "err" });

    vi.advanceTimersByTime(2999);
    expect(toasts().every((t) => !t.leaving)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toasts().find((t) => t.id === "info")?.leaving).toBe(true);
    vi.advanceTimersByTime(200);
    expect(toasts().map((t) => t.id)).toEqual(["err"]);

    vi.advanceTimersByTime(6000 - 3200 - 1);
    expect(only().leaving).toBeFalsy();
    vi.advanceTimersByTime(1 + 200);
    expect(toasts()).toEqual([]);
  });

  it("honours a custom duration", () => {
    toast.success("quick", { duration: 500 });
    vi.advanceTimersByTime(700);
    expect(toasts()).toEqual([]);
  });

  it("never expires a sticky toast", () => {
    toast.info("stays", { duration: "sticky" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(only()).toMatchObject({ message: "stays", duration: "sticky" });
  });

  it("dismisses by id and by handle", () => {
    const a = toast.info("a", { duration: "sticky" });
    toast.info("b", { id: "b", duration: "sticky" });
    a.dismiss();
    toast.dismiss("b");
    expect(toasts()).toEqual([]);
  });

  it("keeps the countdown when only the message changes, restarts it when the status does", () => {
    const h = toast.info("one", { id: "x" });
    vi.advanceTimersByTime(2000);
    h.update({ message: "two" });
    vi.advanceTimersByTime(1000);
    expect(only().leaving).toBe(true);

    const k = toast.info("three", { id: "y" });
    vi.advanceTimersByTime(200);
    vi.advanceTimersByTime(2000);
    k.update({ message: "failed", detail: "why" });
    k.update({ duration: 5000 });
    vi.advanceTimersByTime(4999);
    expect(toasts().find((t) => t.id === "y")?.leaving).toBeFalsy();
    vi.advanceTimersByTime(1);
    expect(toasts().find((t) => t.id === "y")?.leaving).toBe(true);
  });

  it("stores what a toast is about", () => {
    toast.info("agent", { about: { agent: "a1" } });
    expect(only().about).toEqual({ agent: "a1" });
  });
});

describe("toast.progress", () => {
  it("spins with no countdown, then counts down from when it succeeds", () => {
    const p = toast.progress("Cloning…", { about: { workspace: "/w" } });
    expect(only()).toMatchObject({ status: "loading", message: "Cloning…" });
    vi.advanceTimersByTime(60_000);
    expect(only().leaving).toBeFalsy();

    p.succeed("Cloned");
    expect(only()).toMatchObject({
      id: p.id,
      status: "success",
      message: "Cloned",
      about: { workspace: "/w" },
    });
    vi.advanceTimersByTime(2999);
    expect(only().leaving).toBeFalsy();
    vi.advanceTimersByTime(201);
    expect(toasts()).toEqual([]);
  });

  it("fails with the error as detail, reported, on the error countdown", () => {
    const p = toast.progress("Cloning…", { action: { label: "Cancel", onClick: () => {} } });
    const err = new Error("Error invoking remote method 'git:clone': Error: no route");
    p.fail("Clone failed", err);
    expect(only()).toMatchObject({ status: "error", message: "Clone failed", detail: "no route" });
    expect(only().action).toBeUndefined();
    expect(wasReported(err)).toBe(true);
    vi.advanceTimersByTime(5999);
    expect(only().leaving).toBeFalsy();
    vi.advanceTimersByTime(1);
    expect(only().leaving).toBe(true);
  });

  it("updates its message while it spins", () => {
    const p = toast.progress("0%");
    p.update({ message: "50%", detail: "Receiving objects" });
    expect(only()).toMatchObject({ status: "loading", message: "50%", detail: "Receiving objects" });
  });
});

describe("toast.error", () => {
  it("normalises the error into detail and marks it reported", () => {
    const err = new Error("Error invoking remote method 'a:b': HostError: host is away");
    expect(wasReported(err)).toBe(false);
    toast.error("Couldn't reach host", { error: err });
    expect(only()).toMatchObject({ status: "error", detail: "host is away" });
    expect(wasReported(err)).toBe(true);
  });

  it("keeps a detail it was given over the error's", () => {
    toast.error("Nope", { detail: "explained", error: new Error("raw") });
    expect(only().detail).toBe("explained");
  });

  it("normalises a non-Error value; primitives are never 'reported'", () => {
    toast.error("Nope", { error: "plain string" });
    expect(only().detail).toBe("plain string");
    expect(wasReported("plain string")).toBe(false);
  });
});

describe("held countdowns", () => {
  it("holds while the stack is hovered and resumes with the time that was left", () => {
    toast.info("hi");
    vi.advanceTimersByTime(2000);
    setToastStackHovered(true);
    vi.advanceTimersByTime(60_000);
    expect(only().leaving).toBeFalsy();

    setToastStackHovered(false);
    vi.advanceTimersByTime(999);
    expect(only().leaving).toBeFalsy();
    vi.advanceTimersByTime(1);
    expect(only().leaving).toBe(true);
  });

  it("holds while the window is unfocused", () => {
    toast.error("bad");
    vi.advanceTimersByTime(4000);
    pushFocus(false);
    vi.advanceTimersByTime(60_000);
    expect(only().leaving).toBeFalsy();

    pushFocus(true);
    vi.advanceTimersByTime(1999);
    expect(only().leaving).toBeFalsy();
    vi.advanceTimersByTime(1);
    expect(only().leaving).toBe(true);
  });

  it("does not start a toast shown while held until the hold ends", () => {
    pushFocus(false);
    toast.info("arrived unfocused");
    vi.advanceTimersByTime(60_000);
    expect(only().leaving).toBeFalsy();
    pushFocus(true);
    vi.advanceTimersByTime(3000);
    expect(only().leaving).toBe(true);
  });

  it("stays held until both hover and focus release it", () => {
    toast.info("hi");
    setToastStackHovered(true);
    pushFocus(false);
    setToastStackHovered(false);
    vi.advanceTimersByTime(60_000);
    expect(only().leaving).toBeFalsy();
    pushFocus(true);
    vi.advanceTimersByTime(3000);
    expect(only().leaving).toBe(true);
  });

  it("lets go of the hover when the last toast is dismissed from under the pointer", () => {
    const a = toast.info("a", { duration: "sticky" });
    setToastStackHovered(true);
    a.dismiss();
    toast.info("b");
    vi.advanceTimersByTime(3000);
    expect(only().leaving).toBe(true);
  });
});

describe("legacy shims", () => {
  it("addToast/updateToast/removeToast drive the same toasts, `persistent` as sticky", () => {
    const { addToast, updateToast, removeToast } = useToastStore.getState();
    addToast({ id: "old", message: "Working", status: "loading", persistent: true });
    expect(only()).toMatchObject({ id: "old", duration: "sticky" });
    expect(useToastStore.getState().toasts).toEqual([
      { id: "old", message: "Working", status: "loading", persistent: true },
    ]);

    updateToast("old", { status: "success", message: "Done", persistent: false });
    expect(useToastStore.getState().toasts[0]).toEqual({
      id: "old",
      message: "Done",
      status: "success",
    });
    vi.advanceTimersByTime(3200);
    expect(toasts()).toEqual([]);

    addToast({ id: "gone", message: "x", status: "info", duration: 100_000 });
    removeToast("gone");
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("addErrorToast shows a normalised error and marks it reported", () => {
    const err = new Error("boom");
    addErrorToast("e", "Failed", err);
    expect(useToastStore.getState().toasts).toEqual([
      { id: "e", message: "Failed", status: "error", detail: "boom" },
    ]);
    expect(wasReported(err)).toBe(true);
  });

  it("setState({ toasts: [] }) clears every toast and its countdown", () => {
    toast.info("a");
    useToastStore.setState({ toasts: [] });
    expect(toasts()).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(toasts()).toEqual([]);
  });
});
