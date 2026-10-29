import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setToastStackHovered, toast, wasReported, watchToastSubjects, type ToastSubject } from "..";
import { clearRecords, toastStore } from "../toast-store";

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
  clearRecords();
  setToastStackHovered(false);
  pushFocus(true);
});

afterEach(() => {
  clearRecords();
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

describe("clearRecords", () => {
  it("clears every toast and its countdown", () => {
    toast.info("a");
    clearRecords();
    expect(toasts()).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(toasts()).toEqual([]);
  });
});

describe("toast.progress after a close", () => {
  it("succeed() on a toast the user closed does nothing; fail() still shows", () => {
    const ok = toast.progress("Saving", { id: "ok" });
    ok.dismiss();
    ok.succeed("Saved");
    expect(toasts()).toEqual([]);

    const bad = toast.progress("Saving", { id: "bad" });
    bad.dismiss();
    bad.fail("Couldn't save", new Error("disk"));
    expect(only()).toMatchObject({ id: "bad", status: "error", message: "Couldn't save" });
  });
});

describe("subjects", () => {
  // A stand-in for the app layer: a set of subjects on screen, and a nudge.
  let onScreen = new Set<string>();
  let changed: () => void = () => {};
  const key = (s: ToastSubject) => JSON.stringify(s);
  const look = (s: ToastSubject) => {
    onScreen.add(key(s));
    changed();
  };
  const lookAway = (s: ToastSubject) => {
    onScreen.delete(key(s));
    changed();
  };
  const present = () => toasts().filter((t) => !t.leaving);

  beforeEach(() => {
    onScreen = new Set();
    watchToastSubjects({
      isOnScreen: (s) => onScreen.has(key(s)),
      subscribe: (cb) => {
        changed = cb;
        return () => {
          changed = () => {};
        };
      },
    });
  });

  afterEach(() => watchToastSubjects(null));

  it("never shows a toast whose subject is already on screen", () => {
    look({ pane: "p1" });
    toast.info("Pane done", { about: { pane: "p1" } });
    expect(toasts()).toEqual([]);
  });

  it("retracts a toast, with its exit, once its subject comes on screen", () => {
    toast.info("Agent done", { id: "a", about: { agent: "a1" }, duration: "sticky" });
    toast.info("Other", { id: "b", about: { agent: "a2" }, duration: "sticky" });
    look({ agent: "a1" });
    expect(present().map((t) => t.id)).toEqual(["b"]);
    vi.advanceTimersByTime(200);
    expect(toasts().map((t) => t.id)).toEqual(["b"]);
  });

  it("keeps a toast with no subject whatever is on screen", () => {
    toast.info("Plain", { duration: "sticky" });
    look({ workspace: "/ws" });
    expect(present()).toHaveLength(1);
  });

  it("does not bring a retracted toast back when the subject leaves the screen", () => {
    toast.info("x", { about: { pane: "p1" }, duration: "sticky" });
    look({ pane: "p1" });
    lookAway({ pane: "p1" });
    vi.advanceTimersByTime(200);
    expect(toasts()).toEqual([]);
  });

  it("takes the toast it would replace with it when the replacement's subject is on screen", () => {
    toast.info("old", { id: "j" });
    look({ pane: "p1" });
    toast.info("new", { id: "j", about: { pane: "p1" } });
    expect(toasts()).toEqual([]);
  });

  it("retracts on watch: toasts up before the app layer registered", () => {
    watchToastSubjects(null);
    toast.info("early", { about: { pane: "p1" }, duration: "sticky" });
    onScreen.add(key({ pane: "p1" }));
    watchToastSubjects({ isOnScreen: (s) => onScreen.has(key(s)), subscribe: () => () => {} });
    expect(present()).toEqual([]);
  });

  it("a progress toast settled while its subject is on screen does not show", () => {
    const p = toast.progress("Cloning", { about: { workspace: "/ws" } });
    look({ workspace: "/ws" });
    vi.advanceTimersByTime(200);
    p.succeed("Cloned");
    p.fail("Failed");
    expect(toasts()).toEqual([]);
  });
});
