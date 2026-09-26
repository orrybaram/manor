import { describe, it, expect, beforeEach } from "vitest";
import { handleLayoutSaveRejection } from "../app-store";
import { useToastStore } from "../toast-store";
import { BridgeUnavailableError } from "../../web/ws-bridge";

/**
 * `flushLayoutSave` calls this on every debounced `layout.save` rejection
 * (ADR-178 ticket 6). On the web every save is refused with the same
 * `BridgeUnavailableError`, so only the first one may reach the user as a
 * toast — the rest would just be the same fact restated every 500ms.
 */
describe("handleLayoutSaveRejection", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("shows one toast for a BridgeUnavailableError and suppresses the rest", () => {
    const err = new BridgeUnavailableError(
      "layout.save is not available in the browser",
    );
    handleLayoutSaveRejection(err);
    handleLayoutSaveRejection(err);
    handleLayoutSaveRejection(err);

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(
      "Layout changes aren't saved from the browser yet",
    );
  });

  it("does not toast for an error that isn't the web refusal", () => {
    handleLayoutSaveRejection(new Error("disk full"));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
