// @vitest-environment jsdom
/**
 * Settings → Automations. The list groups each host's automations and says
 * when a host can't be read; a row opens its page, where each chip of the
 * sentence saves what it picks, the host of an existing automation can't
 * change, New creates one, and Delete asks first.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const automations = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
    runNow: vi.fn(),
    onChanged: vi.fn(() => () => {}),
  };
  const electronAPI = {
    automations,
    hosts: {
      list: () => new Promise(() => {}),
      onStatusChanged: () => () => {},
      onServerChanged: () => () => {},
      onPairingChanged: () => () => {},
    },
    agents: {
      onStatus: () => () => {},
      onUpdate: () => () => {},
      onRemoved: () => () => {},
      get: vi.fn(),
    },
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = electronAPI;
  return automations;
});

import type { AutomationDetail, AutomationView } from "../../../../lib/automation-views";
import { useHostStore, type HostStatusInfo } from "../../../../store/host-store";
import { useProjectStore, type ProjectInfo } from "../../../../store/project-store";
import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { AutomationsPage } from "../AutomationsPage";

function automation(over: Partial<AutomationView> = {}): AutomationView {
  return {
    id: "a1",
    name: "Morning PR triage",
    enabled: true,
    schedule: { cron: "0 9 * * 1-5", timezone: "Europe/London" },
    projectId: "p-box",
    prompt: "Triage the open PRs.",
    agentKind: "claude",
    workspace: { mode: "new" },
    missedGraceMinutes: 720,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastScheduledFor: "2026-10-29T09:00:00.000Z",
    nextRunAt: "2026-10-30T09:00:00.000Z",
    hostId: "local",
    nextRuns: ["2026-10-30T09:00:00.000Z"],
    lastRun: null,
    ...over,
  };
}

function project(id: string, hostId: string, name: string): ProjectInfo {
  return {
    id,
    name,
    hostId,
    path: `/src/${name}`,
    workspaces: [{ path: `/src/${name}`, branch: "main", isMain: true, name: null }],
  } as unknown as ProjectInfo;
}

const HOSTS: HostStatusInfo[] = [
  { hostId: "local", spec: null, status: "connected" },
  { hostId: "box", spec: { kind: "ssh", target: "box-1" }, label: "box-1", status: "connected" },
  { hostId: "pod", spec: { kind: "ssh", target: "pod-api" }, label: "pod-api", status: "sleeping" },
];

describe("AutomationsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const flush = () => act(async () => {});
  const click = async (el: HTMLElement | null) => {
    expect(el).not.toBeNull();
    await act(async () => {
      el?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  };
  const type = (el: HTMLElement | null, value: string) =>
    act(() => {
      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el?.dispatchEvent(new Event("input", { bubbles: true }));
    });

  async function render() {
    await act(async () => {
      root.render(createElement(TooltipProvider, null, createElement(AutomationsPage)));
    });
    await flush();
  }

  async function openA1() {
    const detail: AutomationDetail = {
      ...automation({ hostId: "box" }),
      runs: [
        {
          id: "r1",
          automationId: "a1",
          scheduledFor: "2026-10-29T09:00:00.000Z",
          firedAt: "2026-10-29T09:00:00.000Z",
          trigger: "schedule",
          outcome: "started",
          status: "requires_input",
          agentId: "agent-1",
          workspacePath: "box:/src/manor",
        },
      ],
    };
    api.get.mockResolvedValue(detail);
    await render();
    await click(q("automations-row-a1"));
    return detail;
  }

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.onChanged.mockReturnValue(() => {});
    api.list.mockImplementation((hostId: string) =>
      Promise.resolve(
        hostId === "box"
          ? [automation({ hostId: "box" })]
          : [
              automation({
                id: "a4",
                name: "Weekly changelog draft",
                projectId: "p-local",
                enabled: false,
                schedule: { cron: "0 16 * * 5", timezone: "Europe/London" },
              }),
            ],
      ),
    );
    useHostStore.setState({ hosts: HOSTS, servers: {} });
    useProjectStore.setState({
      projects: [project("p-local", "local", "notes"), project("p-box", "box", "manor")],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("lists each host's automations under it, and says a host is asleep without asking it", async () => {
    await render();
    expect(api.list.mock.calls.map((c) => c[0]).sort()).toEqual(["box", "local"]);
    const local = q("automations-host-local");
    expect(local?.textContent).toContain("This Mac");
    expect(local?.textContent).toContain("runs only while Manor is open");
    expect(q("automations-row-a4")?.textContent).toContain("Fridays at 16:00");
    expect(q("automations-row-a4")?.textContent).toContain("Paused");
    const box = q("automations-host-box");
    expect(box?.textContent).toContain("box-1");
    expect(q("automations-row-a1")?.textContent).toContain("Weekdays at 09:00");
    expect(q("automations-row-a1")?.textContent).toContain("manor · Claude");
    expect(q("automations-host-pod")?.textContent).toContain("pod-api is asleep");
  });

  it("opens an automation's page from its row, with its runs", async () => {
    await openA1();
    expect(api.get).toHaveBeenCalledWith("box", "a1");
    expect(q("automation-detail")).not.toBeNull();
    expect((q("automation-name") as HTMLInputElement).value).toBe("Morning PR triage");
    expect(q("automation-run-r1")?.textContent).toContain("Opened main");
    expect(q("automation-run-r1")?.textContent).toContain("Needs input");
    expect(q("automation-detail")?.textContent).toContain("If box-1 is asleep at that time");
  });

  it("saves what a chip's menu picks", async () => {
    await openA1();
    api.update.mockResolvedValue(automation({ hostId: "box", agentKind: "codex" }));
    await click(q("automation-chip-agent"));
    await click(q("automation-agent-codex"));
    expect(api.update).toHaveBeenCalledWith("box", "a1", { agentKind: "codex" });
    expect(q("automation-chip-agent")?.textContent).toContain("Codex");

    await click(q("automation-chip-schedule"));
    await click(q("automation-schedule-daily"));
    expect(api.update).toHaveBeenLastCalledWith("box", "a1", {
      schedule: { cron: "0 9 * * *", timezone: "Europe/London" },
    });

    await click(q("automation-chip-workspace"));
    await click(q("automation-workspace-reuse-main"));
    expect(api.update).toHaveBeenLastCalledWith("box", "a1", {
      workspace: { mode: "reuse", workspacePath: "box:/src/manor" },
    });
  });

  it("shows an existing automation's host as a label, not a menu", async () => {
    await openA1();
    const host = q("automation-chip-host");
    expect(host?.tagName).toBe("SPAN");
    expect(host?.textContent).toBe("box-1");
    await click(host);
    expect(q("automation-menu-host")).toBeNull();
  });

  it("creates a new automation, paused, from the defaults", async () => {
    await render();
    api.create.mockResolvedValue(automation({ id: "new1", enabled: false }));
    api.get.mockResolvedValue({ ...automation({ id: "new1", enabled: false }), runs: [] });
    await click(q("automation-new"));
    expect(q("automation-detail")?.textContent).toContain("No runs yet. Create it paused");
    expect(q("automation-chip-host")?.tagName).toBe("BUTTON");

    await click(q("automation-create"));
    expect(api.create).not.toHaveBeenCalled();
    expect(q("automation-error")?.textContent).toBe("Prompt is required");

    await type(q("automation-prompt"), "Draft the changelog.");
    await click(q("automation-create"));
    expect(api.create).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        name: "New automation",
        enabled: false,
        projectId: "p-local",
        prompt: "Draft the changelog.",
        agentKind: "claude",
        workspace: { mode: "new" },
        schedule: expect.objectContaining({ cron: "0 9 * * 1-5" }),
      }),
    );
    expect(api.get).toHaveBeenCalledWith("local", "new1");
  });

  it("deletes only once confirmed", async () => {
    await openA1();
    api.remove.mockResolvedValue(true);
    await click(q("automation-delete"));
    expect(api.remove).not.toHaveBeenCalled();
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Delete",
    );
    await click(confirm ?? null);
    expect(api.remove).toHaveBeenCalledWith("box", "a1");
    expect(q("automations-page")).not.toBeNull();
  });
});
