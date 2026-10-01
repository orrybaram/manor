import { describe, it, expect, beforeEach } from "vitest";
import {
  showBridgeUnavailableToastOnce,
  handleBridgeUnavailable,
} from "../bridge-unavailable-toast";
import { useToastStore } from "../../store/toast-store";
import { BridgeUnavailableError } from "../../bridge/client";

/**
 * The once-per-session toast shared by `layout.save` (ticket 6),
 * `preferences.set` and `keybindings.set`/`reset`/`resetAll` (ticket 9) —
 * every fire-and-forget bridge call refused with the same
 * `BridgeUnavailableError` on a browser.
 */
describe("showBridgeUnavailableToastOnce", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("shows one toast per id and suppresses repeats", () => {
    showBridgeUnavailableToastOnce("test-once-a", "first message");
    showBridgeUnavailableToastOnce("test-once-a", "first message");
    showBridgeUnavailableToastOnce("test-once-a", "first message");

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("first message");
  });

  it("shows a separate toast for a different id", () => {
    showBridgeUnavailableToastOnce("test-once-b1", "one");
    showBridgeUnavailableToastOnce("test-once-b2", "two");
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });
});

describe("handleBridgeUnavailable", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("shows the toast once for a BridgeUnavailableError", () => {
    const handler = handleBridgeUnavailable("test-catch-a", "message");
    const err = new BridgeUnavailableError(
      "preferences.set is not available in the browser",
    );
    handler(err);
    handler(err);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("rethrows anything else instead of swallowing it", () => {
    const handler = handleBridgeUnavailable("test-catch-b", "message");
    expect(() => handler(new Error("disk full"))).toThrow("disk full");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
