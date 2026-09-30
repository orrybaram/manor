// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { TabTitle } from "../TabButton";
import { makeAgent } from "../../../test-utils/fixtures";
import {
  createTestRoot,
  renderCounted,
  setPaneTitle,
  type TestRoot,
} from "../../../test-utils/react-root";

const PANE = "pane-1";
const tabTitle = createElement(TabTitle, { focusedPaneId: PANE, isPinned: false });

describe("TabTitle", () => {
  let root: TestRoot;

  beforeEach(() => {
    useAppStore.setState({
      paneTitle: { [PANE]: "⠂ Fix the build" },
      paneCwd: {},
      paneContentType: {},
      paneUrl: {},
    });
    useAgentStore.setState({ agents: [] });
    root = createTestRoot();
  });

  afterEach(() => root.unmount());

  it("shows the cleaned title and ignores spinner frames of it", () => {
    const tab = renderCounted(root, tabTitle);
    expect(root.container.textContent).toBe("Fix the build");

    setPaneTitle(PANE, "⠐ Fix the build");
    setPaneTitle(PANE, "⠠ Fix the build");
    expect(tab.commits).toBe(1);

    setPaneTitle(PANE, "user@host:/home/me/code");
    expect(tab.commits).toBe(2);
    expect(root.container.textContent).toBe("code");
  });

  it("shows a pinned agent name over the live title", () => {
    useAgentStore.setState({
      agents: [makeAgent({ paneId: PANE, name: "Release", namePinned: true })],
    });
    renderCounted(root, tabTitle);
    expect(root.container.textContent).toBe("Release");
  });
});
