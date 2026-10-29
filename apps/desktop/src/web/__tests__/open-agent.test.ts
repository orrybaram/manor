/**
 * A tapped notification's `open-agent` message from `sw.ts`
 * opens that agent in the web app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentInfo } from "../../electron.d";
import { useAgentStore } from "../../store/agent-store";
import { navigateToAgent } from "../../utils/agent-navigation";
import { listenForOpenAgent } from "../open-agent";
import { pushClickMessage } from "../push-click";
import { onUiRequest, type UiRequest } from "../../utils/ui-request";

vi.mock("../../utils/agent-navigation", () => ({ navigateToAgent: vi.fn() }));

const navigate = vi.mocked(navigateToAgent);

function agent(id: string): AgentInfo {
  return { id } as AgentInfo;
}

function post(target: EventTarget, data: unknown): void {
  const event = new Event("message") as Event & { data: unknown };
  Object.defineProperty(event, "data", { value: data });
  target.dispatchEvent(event);
}

describe("listenForOpenAgent", () => {
  let container: EventTarget;
  let get: ReturnType<typeof vi.fn>;
  let previousGet: unknown;
  let stop: () => void;

  beforeEach(() => {
    navigate.mockReset();
    container = new EventTarget();
    useAgentStore.setState({ agents: [agent("known")] });
    const agents = (
      window as unknown as { electronAPI: { agents: { get?: unknown } } }
    ).electronAPI.agents;
    previousGet = agents.get;
    get = vi.fn(async (id: string) => (id === "fetched" ? agent(id) : null));
    agents.get = get;
    stop = listenForOpenAgent(container);
  });

  afterEach(() => {
    stop();
    (
      window as unknown as { electronAPI: { agents: { get?: unknown } } }
    ).electronAPI.agents.get = previousGet;
  });

  it("opens an agent the store already has", async () => {
    post(container, { type: "open-agent", agentId: "known" });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(navigate.mock.calls[0][0].id).toBe("known");
    expect(get).not.toHaveBeenCalled();
  });

  it("fetches an agent the store has not seen", async () => {
    post(container, { type: "open-agent", agentId: "fetched" });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(navigate.mock.calls[0][0].id).toBe("fetched");
  });

  it("does nothing for a pruned agent or another message", async () => {
    post(container, { type: "open-agent", agentId: "gone" });
    post(container, { type: "something-else", agentId: "known" });
    post(container, { type: "open-agent" });
    post(container, null);
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the automation of a run that failed to start, on its host", () => {
    const requests: UiRequest[] = [];
    const off = onUiRequest((request) => requests.push(request));
    try {
      // What the worker posts for a failed-to-start push's notification.
      post(container, pushClickMessage({ automationId: "auto-1", hostId: "room-box" }));
      // A server with no room named no host: home.
      post(container, pushClickMessage({ automationId: "auto-2" }));
      expect(requests).toEqual([
        { type: "open-automation", hostId: "room-box", automationId: "auto-1" },
        { type: "open-automation", hostId: "local", automationId: "auto-2" },
      ]);
    } finally {
      off();
    }
  });

  it("stops listening when unsubscribed", async () => {
    stop();
    post(container, { type: "open-agent", agentId: "known" });
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });
});
