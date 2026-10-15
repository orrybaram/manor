import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installUnhandledRejectionToasts } from "../unhandled-rejection";
import { addErrorToast, useToastStore } from "../../store/toast-store";

type Handler = (event: PromiseRejectionEvent) => void;

/** ADR-232 D2. */
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
    useToastStore.setState({ toasts: [] });
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
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Something went wrong");
    expect(toasts[0].detail).toBe("host is away");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does not toast an error addErrorToast already showed", () => {
    const err = new Error("save failed");
    addErrorToast("save", "Couldn't save", err);
    reject(err);
    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual(["save"]);
  });

  it("ignores a cancelled request", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const event = reject(abort);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("uninstalls its listener", () => {
    uninstall();
    expect(remove).toHaveBeenCalledWith("unhandledrejection", handler);
  });
});
