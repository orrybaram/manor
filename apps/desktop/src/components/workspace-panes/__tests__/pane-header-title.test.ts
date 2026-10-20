// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../../store/app-store";
import { PaneHeaderTitle } from "../PaneHeaderTitle";
import {
  createTestRoot,
  renderCounted,
  setPaneTitle,
  type TestRoot,
} from "../../../test-utils/react-root";

const PANE = "pane-1";

describe("PaneHeaderTitle", () => {
  let root: TestRoot;

  beforeEach(() => {
    useAppStore.setState({ paneTitle: { [PANE]: "⠂ Fix the build" }, paneCwd: {} });
    root = createTestRoot();
  });

  afterEach(() => root.unmount());

  it("shows the cleaned title and ignores spinner frames of it", () => {
    const header = renderCounted(root, createElement(PaneHeaderTitle, { paneId: PANE }));
    expect(root.container.textContent).toBe("Fix the build");

    setPaneTitle(PANE, "⠐ Fix the build");
    setPaneTitle(PANE, "✳ Fix the build");
    expect(header.commits).toBe(1);

    setPaneTitle(PANE, "⠂ Run the tests");
    expect(header.commits).toBe(2);
    expect(root.container.textContent).toBe("Run the tests");
  });

  it("drops the user@host: prefix of a shell title", () => {
    setPaneTitle(PANE, "user@host:~/code");
    renderCounted(root, createElement(PaneHeaderTitle, { paneId: PANE }));
    expect(root.container.textContent).toBe("~/code");
  });

  it("falls back to the cwd when the title is only a spinner", () => {
    useAppStore.setState({ paneTitle: { [PANE]: "⠂" }, paneCwd: { [PANE]: "/repo/app/" } });
    renderCounted(root, createElement(PaneHeaderTitle, { paneId: PANE }));
    expect(root.container.textContent).toBe("app");
  });
});
