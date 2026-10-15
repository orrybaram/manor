// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot, type TestRoot } from "../../../../test-utils/react-root";
import { PaneErrorBoundary } from "../../../workspace-panes/PaneErrorBoundary";

/** ADR-232 D3: one pane's crash stays in that pane, and it can be reloaded. */
describe("PaneErrorBoundary", () => {
  let root: TestRoot;
  let shouldThrow = true;

  function Bomb(props: { label: string }) {
    if (shouldThrow && props.label === "bad") throw new Error("kaboom");
    return createElement("div", { "data-testid": `pane-${props.label}` }, props.label);
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    shouldThrow = true;
    root = createTestRoot();
  });

  afterEach(() => {
    root.unmount();
    vi.restoreAllMocks();
  });

  function q(id: string) {
    return root.container.querySelector(`[data-testid='${id}']`);
  }

  it("shows a fallback for the crashed pane and leaves its sibling alone", () => {
    root.render(
      createElement(
        "div",
        null,
        createElement(PaneErrorBoundary, { paneId: "a", children: createElement(Bomb, { label: "bad" }) }),
        createElement(PaneErrorBoundary, { paneId: "b", children: createElement(Bomb, { label: "good" }) }),
      ),
    );

    expect(q("pane-crashed")?.textContent).toContain("This pane crashed");
    expect(q("pane-crashed")?.textContent).toContain("kaboom");
    expect(q("pane-good")).not.toBeNull();
  });

  it("Reload pane remounts the pane", () => {
    root.render(
      createElement(PaneErrorBoundary, { paneId: "a", children: createElement(Bomb, { label: "bad" }) }),
    );
    shouldThrow = false;
    const reload = [...root.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Reload pane",
    );
    act(() => reload?.click());

    expect(q("pane-crashed")).toBeNull();
    expect(q("pane-bad")).not.toBeNull();
  });
});
