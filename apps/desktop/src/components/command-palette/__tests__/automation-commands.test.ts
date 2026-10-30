// @vitest-environment happy-dom
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  const automations = { list: vi.fn(), runNow: vi.fn() };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    automations,
    hosts: {
      list: () => new Promise(() => {}),
      onStatusChanged: () => () => {},
      onServerChanged: () => () => {},
      onPairingChanged: () => () => {},
    },
  };
  return automations;
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../../../toast", () => ({ toast }));

import type { AutomationView } from "../../../lib/automation-views";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import { useProjectStore } from "../../../store/project-store";
import { onUiRequest, type UiRequest } from "../../../utils/ui-request";
import { makeProject } from "../../../test-utils/fixtures";
import { createTestRoot, type TestRoot } from "../../../test-utils/react-root";
import { useAutomationCommands } from "../useAutomationCommands";

function automation(
  id: string,
  name: string,
  projectId: string,
): AutomationView {
  return {
    id,
    name,
    enabled: true,
    schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
    projectId,
    prompt: "Triage.",
    agentKind: "claude",
    workspace: { mode: "new" },
    missedGraceMinutes: 60,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastScheduledFor: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
    hostId: "local",
    nextRuns: [],
    lastRun: null,
  };
}

const HOSTS: HostStatusInfo[] = [
  { hostId: "local", spec: null, label: "This Mac", status: "connected" },
  {
    hostId: "box",
    spec: { kind: "ssh", target: "box-1" },
    label: "box-1",
    status: "connected",
  },
  {
    hostId: "pod",
    spec: { kind: "ssh", target: "pod-api" },
    label: "pod-api",
    status: "sleeping",
  },
];

describe("useAutomationCommands", () => {
  let root: TestRoot;
  const onClose = vi.fn();

  function Probe(props: {
    scope: ReadonlySet<string> | null;
    enabled: boolean;
  }) {
    const items = useAutomationCommands({
      onClose,
      scopeProjectIds: props.scope,
      enabled: props.enabled,
    });
    // Each row as a button: its id, label, keywords and whether it has a suffix.
    return items.map((i) =>
      createElement(
        "button",
        {
          key: i.id,
          "data-id": i.id,
          "data-keywords": (i.keywords ?? []).join(","),
          "data-suffix": i.suffix ? "yes" : "no",
          onClick: i.action,
        },
        i.label,
      ),
    );
  }

  const client = new QueryClient();
  async function render(
    scope: ReadonlySet<string> | null = null,
    enabled = true,
  ) {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Probe, { scope, enabled }),
      ),
    );
    // React Query hands its result over on a timer.
    await act(() => new Promise<void>((r) => setTimeout(r, 10)));
  }
  const rows = () => [
    ...root.container.querySelectorAll<HTMLButtonElement>("button"),
  ];
  const ids = () => rows().map((b) => b.dataset.id);
  const row = (id: string) => rows().find((b) => b.dataset.id === id);

  beforeEach(() => {
    client.clear();
    api.list.mockReset();
    api.runNow.mockReset();
    onClose.mockReset();
    api.list.mockImplementation((hostId: string) =>
      Promise.resolve(
        hostId === "box"
          ? [automation("a1", "Morning PR triage", "p-box")]
          : [automation("a2", "Weekly changelog", "p-local")],
      ),
    );
    useHostStore.setState({ hosts: HOSTS, servers: {} });
    useProjectStore.setState({
      projects: [
        makeProject({ id: "p-local", name: "notes" }),
        makeProject({ id: "p-box", name: "manor" }),
      ],
    });
    root = createTestRoot();
  });

  afterEach(() => root.unmount());

  it("asks no host while the palette is closed", async () => {
    await render(null, false);
    expect(api.list).not.toHaveBeenCalled();
    expect(ids()).toEqual(["new-automation"]);
  });

  it("lists each automation of the hosts that are up, never waking one asleep", async () => {
    await render();
    expect(api.list.mock.calls.map((c) => c[0]).sort()).toEqual([
      "box",
      "local",
    ]);
    expect(rows().map((b) => b.textContent)).toEqual([
      "New Automation",
      "Weekly changelog",
      "Run Now: Weekly changelog",
      "Morning PR triage",
      "Run Now: Morning PR triage",
    ]);
    expect(row("automation-box:a1")?.dataset.keywords).toBe(
      "automation,manor,box-1",
    );
    expect(row("automation-box:a1")?.dataset.suffix).toBe("yes");
    expect(row("automation-local:a2")?.dataset.suffix).toBe("no");
  });

  it("lists only the scoped projects' automations", async () => {
    await render(new Set(["p-box"]));
    expect(ids()).toEqual([
      "new-automation",
      "automation-box:a1",
      "automation-run-box:a1",
    ]);
  });

  it("opens an automation's page, or a new one, in Settings", async () => {
    const requests: UiRequest[] = [];
    const off = onUiRequest((r) => requests.push(r));
    await render();
    row("automation-box:a1")?.click();
    row("new-automation")?.click();
    off();
    expect(requests).toEqual([
      { type: "open-automation", hostId: "box", automationId: "a1" },
      { type: "new-automation" },
    ]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("runs one now on its own host, and says so", async () => {
    api.runNow.mockResolvedValue(undefined);
    await render();
    await act(async () => row("automation-run-box:a1")?.click());
    expect(api.runNow).toHaveBeenCalledWith("box", "a1");
    expect(toast.success).toHaveBeenCalledWith("Started Morning PR triage");

    api.runNow.mockRejectedValue(new Error("Project is gone"));
    await act(async () => row("automation-run-local:a2")?.click());
    expect(toast.error).toHaveBeenCalledWith("Couldn't run Weekly changelog", {
      detail: "Project is gone",
    });
  });
});
