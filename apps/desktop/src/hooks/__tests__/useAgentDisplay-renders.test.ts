// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../store/app-store";
import { useAgentDisplay } from "../useAgentDisplay";
import { makeAgent } from "../../test-utils/fixtures";
import {
  createTestRoot,
  renderCounted,
  setPaneTitle,
  type TestRoot,
} from "../../test-utils/react-root";

const PANE = "pane-1";
const agent = makeAgent({ paneId: PANE });

function AgentRowTitle() {
  return useAgentDisplay(agent).title;
}

describe("useAgentDisplay", () => {
  let root: TestRoot;

  beforeEach(() => {
    useAppStore.setState({ paneTitle: { [PANE]: "⠂ Fix the build" }, paneAgentStatus: {} });
    root = createTestRoot();
  });

  afterEach(() => root.unmount());

  it("does not re-render an agents list row for a spinner frame of the same title", () => {
    const row = renderCounted(root, createElement(AgentRowTitle));
    setPaneTitle(PANE, "⠐ Fix the build");
    setPaneTitle(PANE, "⠠ Fix the build");
    expect(row.commits).toBe(1);
    expect(root.container.textContent).toBe("Fix the build");

    setPaneTitle(PANE, "⠂ Run the tests");
    expect(row.commits).toBe(2);
    expect(root.container.textContent).toBe("Run the tests");
  });
});
