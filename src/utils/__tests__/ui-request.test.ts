import { describe, it, expect, vi } from "vitest";
import { onUiRequest, requestUi, type UiRequest } from "../ui-request";

describe("ui-request bus", () => {
  it("delivers a request to a subscribed listener", () => {
    const listener = vi.fn();
    const unsubscribe = onUiRequest(listener);

    const request: UiRequest = { type: "open-notifications" };
    requestUi(request);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(request);

    unsubscribe();
  });

  it("stops delivering requests once unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = onUiRequest(listener);

    unsubscribe();
    requestUi({ type: "open-notifications" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies every subscribed listener", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = onUiRequest(first);
    const unsubscribeSecond = onUiRequest(second);

    const request: UiRequest = { type: "ghosts" };
    requestUi(request);

    expect(first).toHaveBeenCalledWith(request);
    expect(second).toHaveBeenCalledWith(request);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("only unsubscribes the listener whose unsubscribe was called", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = onUiRequest(first);
    const unsubscribeSecond = onUiRequest(second);

    unsubscribeFirst();
    requestUi({ type: "ghosts" });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeSecond();
  });
});
