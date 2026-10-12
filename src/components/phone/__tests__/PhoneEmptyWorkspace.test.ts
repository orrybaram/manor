// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Every namespace the stores touch at import: any method resolves empty.
  const ns = () =>
    new Proxy({}, { get: () => () => Promise.resolve([]) }) as object;
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
    { claim: null },
    { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : ns()) },
  );
});

import { PhoneEmptyWorkspace } from "../PhoneEmptyWorkspace";
import { HOST_UNAVAILABLE_COPY, markHostRestricted } from "../../../bridge/host-restrictions";

describe("PhoneEmptyWorkspace on a host server", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says launching is not available once the host refuses with unavailable:host", () => {
    act(() => root.render(createElement(PhoneEmptyWorkspace)));
    expect(container.querySelector('[data-testid="phone-empty-unavailable"]')).toBeNull();
    act(() => markHostRestricted());
    expect(
      container.querySelector('[data-testid="phone-empty-unavailable"]')?.textContent,
    ).toBe(HOST_UNAVAILABLE_COPY);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="phone-empty-send"]')!.disabled,
    ).toBe(true);
  });
});
