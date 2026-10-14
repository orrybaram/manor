// @vitest-environment happy-dom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeTransport } from "../../../bridge/client";
import { servers } from "../../../bridge/server-set";
import { useProjectStore } from "../../../store/project-store";
import { makeProject } from "../../../test-utils/fixtures";
import { createTestRoot, type TestRoot } from "../../../test-utils/react-root";

const { TasksView } = await import("../TasksView");

/** A transport whose server answers `linear.isConnected` with `connected`. */
function transport(connected: boolean): BridgeTransport {
  return {
    start() {},
    rendererId: "r1",
    platform: "electron",
    rootValues: { claim: null },
    localNamespaces: {},
    locallyServed: {},
    invoke: () => Promise.resolve(connected),
    subscribe: () => () => {},
  };
}

/** Let the status queries settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("TasksView with Linear on no server (ADR-228 D10)", () => {
  let root: TestRoot;

  beforeEach(() => {
    Object.assign(window, {
      electronAPI: {
        github: {
          checkStatus: () => Promise.resolve({ installed: false, authenticated: false }),
        },
      },
    });
    root = createTestRoot();
  });

  afterEach(() => {
    root.unmount();
    servers.remove("box");
    useProjectStore.setState({ projects: [] });
  });

  it("says why, rather than the generic setup hint", async () => {
    servers.add("local", transport(false), { home: true, lists: "all" });
    servers.setReachability("local", "connected");
    servers.add("box", transport(false));
    servers.recordHello("box", { hostName: "wsl-box", hostServer: true });
    servers.setReachability("box", "connected");
    useProjectStore.setState({
      projects: [
        makeProject({
          linearAssociations: [{ teamId: "t1", teamName: "T", teamKey: "T" } as never],
        }),
      ],
    });

    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TasksView, { onNewWorkspace: () => {} }),
      ),
    );
    await settle();

    const hint = root.container.querySelector("[data-testid='tasks-setup-hint']");
    expect(hint?.textContent).toBe(
      "Linear isn't connected on This Mac, and no host has it turned on.",
    );
  });
});
