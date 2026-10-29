import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installUnhandledRejectionToasts } from "../unhandled-rejection";
import { clearRecords, toastStore } from "../../toast/toast-store";
import { toast } from "../../toast";

type Handler = (event: PromiseRejectionEvent) => void;

describe("installUnhandledRejectionToasts", () => {
  let handler: Handler | null = null;
  let uninstall: () => void;
  const add = vi.fn((type: string, h: Handler) => {
    if (type === "unhandledrejection") handler = h;
  });
  const remove = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("window", { ...window, addEventListener: add, removeEventListener: remove });
    vi.spyOn(console, "error").mockImplementation(() => {});
    clearRecords();
    uninstall = installUnhandledRejectionToasts();
  });

  afterEach(() => {
    uninstall();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function reject(reason: unknown) {
    const event = { reason, preventDefault: vi.fn() };
    handler?.(event as unknown as PromiseRejectionEvent);
    return event;
  }

  it("toasts an unhandled rejection with a readable detail", () => {
    const event = reject(
      new Error("Error invoking remote method 'x:y': HostError: host is away"),
    );
    const toasts = toastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Something went wrong");
    expect(toasts[0].detail).toBe("host is away");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does not toast an error toast.error already showed", () => {
    const err = new Error("save failed");
    toast.error("Couldn't save", { id: "save", error: err });
    reject(err);
    expect(toastStore.getState().toasts.map((t) => t.id)).toEqual(["save"]);
  });

  it("ignores a cancelled request", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const event = reject(abort);
    expect(toastStore.getState().toasts).toHaveLength(0);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("uninstalls its listener", () => {
    uninstall();
    expect(remove).toHaveBeenCalledWith("unhandledrejection", handler);
  });
});
