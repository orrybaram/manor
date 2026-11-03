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
import { AutomationsPage, type AutomationTarget } from "../AutomationsPage";

type StatusListener = (update: { paneId: string }) => void;
type ChangedListener = (info: { hostId: string; automationId: string }) => void;

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

  let statusListeners: StatusListener[] = [];
  let changedListeners: ChangedListener[] = [];
  const blur = (el: HTMLElement | null) =>
    act(async () => {
      el?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
  const key = (el: EventTarget | null, k: string) =>
    act(async () => {
      el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    });
  const select = (el: HTMLElement | null, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(el, value);
      el?.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 900)));

  async function render(target?: AutomationTarget | null) {
    await act(async () => {
      root.render(
        createElement(TooltipProvider, null, createElement(AutomationsPage, { target })),
      );
    });
    await flush();
  }

  async function openA1(over: Partial<AutomationDetail> = {}) {
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
          paneId: "pane-r1",
        },
      ],
      ...over,
    };
    api.get.mockResolvedValue(detail);
    await render();
    await click(q("automations-row-a1"));
    return detail;
  }

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    changedListeners = [];
    api.onChanged.mockImplementation(((cb: ChangedListener) => {
      changedListeners.push(cb);
      return () => {};
    }) as never);
    statusListeners = [];
    (window.electronAPI.agents as { onStatus: unknown }).onStatus = (cb: StatusListener) => {
      statusListeners.push(cb);
      return () => {};
    };
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

  it("saves typing still settling when the page closes, as Settings closing with Escape does", async () => {
    await openA1();
    api.update.mockResolvedValue(automation({ hostId: "box" }));
    await type(q("automation-name"), "Evening PR triage");
    expect(api.update).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(api.update).toHaveBeenCalledWith("box", "a1", { name: "Evening PR triage" });
    root = createRoot(container);
  });

  it("keeps a typed cron when the schedule menu is closed with Escape", async () => {
    await openA1();
    api.update.mockResolvedValue(automation({ hostId: "box" }));
    await click(q("automation-chip-schedule"));
    await click(q("automation-schedule-custom"));
    await type(q("automation-schedule-cron"), "0 */6 * * 1-5");
    await key(document, "Escape");
    await flush();
    expect(q("automation-menu-schedule")).toBeNull();
    expect(api.update).toHaveBeenCalledWith("box", "a1", {
      schedule: { cron: "0 */6 * * 1-5", timezone: "Europe/London" },
    });
  });

  it("saves an hourly minute once it is entered, never an empty field as 0", async () => {
    await openA1({ schedule: { cron: "5 * * * *", timezone: "Europe/London" } });
    api.update.mockResolvedValue(automation({ hostId: "box" }));
    await click(q("automation-chip-schedule"));
    const minute = q("automation-schedule-minute");
    await type(minute, "");
    await blur(minute);
    await type(minute, "75");
    await blur(minute);
    expect(api.update).not.toHaveBeenCalled();
    expect(q("automation-menu-schedule")?.textContent).toContain("A minute from 0 to 59");
    await type(minute, "15");
    expect(api.update).not.toHaveBeenCalled();
    await key(minute, "Enter");
    expect(api.update).toHaveBeenCalledWith("box", "a1", {
      schedule: { cron: "15 * * * *", timezone: "Europe/London" },
    });
  });

  it("changes the zone a schedule is read in", async () => {
    await openA1();
    api.update.mockResolvedValue(automation({ hostId: "box" }));
    await click(q("automation-chip-schedule"));
    const zone = q("automation-schedule-timezone") as HTMLSelectElement;
    expect(zone.options[0].value).toBe("Europe/London");
    await select(zone, "Asia/Tokyo");
    expect(api.update).toHaveBeenCalledWith("box", "a1", {
      schedule: { cron: "0 9 * * 1-5", timezone: "Asia/Tokyo" },
    });
  });

  it("shows upcoming runs at the schedule's own time, labelled when its zone isn't the viewer's", async () => {
    await openA1({ schedule: { cron: "0 9 * * *", timezone: "Pacific/Chatham" } });
    const note = q("automation-next-runs")?.textContent ?? "";
    expect(note).toMatch(/next \w{3} \d{1,2} \w{3} 09:00/);
    expect(note).toContain("(Chatham time)");
  });

  it("clears Keep last without stalling later saves, and keeps it to 1–20", async () => {
    await openA1({ workspace: { mode: "new", keepLast: 3 } });
    api.update.mockResolvedValue(automation({ hostId: "box" }));
    await click(q("automation-chip-workspace"));
    const keep = q("automation-workspace-keep") as HTMLInputElement;
    expect(keep.max).toBe("20");
    await type(keep, "25");
    await blur(keep);
    expect(api.update).not.toHaveBeenCalled();
    expect(q("automation-menu-workspace")?.textContent).toContain("Keep 1 to 20");
    await type(keep, "");
    await blur(keep);
    expect(api.update).toHaveBeenLastCalledWith("box", "a1", { workspace: { mode: "new", keepLast: null } });
    expect(q("automation-error")).toBeNull();
    // A later save goes alone: the cleared one isn't held back as invalid.
    await type(q("automation-name"), "Evening PR triage");
    await blur(q("automation-name"));
    expect(api.update).toHaveBeenLastCalledWith("box", "a1", { name: "Evening PR triage" });
  });

  it("creates with Keep last cleared as a plain new workspace", async () => {
    await render();
    api.create.mockResolvedValue(automation({ id: "new1", enabled: false }));
    api.get.mockResolvedValue({ ...automation({ id: "new1", enabled: false }), runs: [] });
    await click(q("automation-new"));
    await type(q("automation-prompt"), "Draft the changelog.");
    await click(q("automation-chip-workspace"));
    const keep = q("automation-workspace-keep");
    await type(keep, "3");
    await blur(keep);
    await type(keep, "");
    await blur(keep);
    await key(document, "Escape");
    await click(q("automation-create"));
    expect(q("automation-error")).toBeNull();
    expect(api.create.mock.calls[0][1].workspace).toEqual({ mode: "new" });
  });

  it("shows a change made elsewhere, unless a field here is being edited", async () => {
    const detail = await openA1();
    api.update.mockResolvedValue(automation({ hostId: "box" }));
    expect((q("automation-enabled") as HTMLElement).getAttribute("aria-checked")).toBe("true");
    api.get.mockResolvedValue({
      ...detail,
      enabled: false,
      prompt: "Triage, then nap.",
      updatedAt: "2026-10-29T10:00:00.000Z",
    });
    await act(async () => {
      for (const cb of changedListeners) cb({ hostId: "box", automationId: "a1" });
    });
    await flush();
    expect((q("automation-enabled") as HTMLElement).getAttribute("aria-checked")).toBe("false");
    expect((q("automation-prompt") as HTMLTextAreaElement).value).toBe("Triage, then nap.");

    // Mid-edit, the page keeps what is typed.
    const name = q("automation-name") as HTMLInputElement;
    name.focus();
    await type(name, "Mine");
    api.get.mockResolvedValue({ ...detail, name: "Theirs", updatedAt: "2026-10-29T11:00:00.000Z" });
    await act(async () => {
      for (const cb of changedListeners) cb({ hostId: "box", automationId: "a1" });
    });
    await flush();
    expect(name.value).toBe("Mine");
  });

  it("says why a delete was refused, instead of leaving it unhandled", async () => {
    await openA1();
    api.remove.mockRejectedValue(new Error("A device can't delete automations"));
    await click(q("automation-delete"));
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Delete",
    );
    await click(confirm ?? null);
    expect(q("automation-error")?.textContent).toBe("A device can't delete automations");
    expect(q("automation-detail")).not.toBeNull();
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Delete")).toBe(false);
  });

  it("says a run found no project until another one is picked", async () => {
    await openA1({
      projectId: "p-gone",
      lastRun: {
        id: "r2",
        automationId: "a1",
        scheduledFor: "2026-10-29T09:00:00.000Z",
        firedAt: "2026-10-29T09:00:00.000Z",
        trigger: "schedule",
        outcome: "failed",
        reason: "project-missing",
        status: null,
      },
    });
    api.update.mockResolvedValue(automation({ hostId: "box" }));
    expect(q("automation-project-missing")).not.toBeNull();
    await click(q("automation-chip-project"));
    await click(q("automation-project-p-box"));
    expect(q("automation-project-missing")).toBeNull();
  });

  it("says the project is missing before any run has found that", async () => {
    await openA1({ projectId: "p-gone", lastRun: null });
    expect(q("automation-project-missing")).not.toBeNull();
  });

  it("re-reads a list only for its own run's agent, once a burst settles, and not under a page", async () => {
    api.list.mockImplementation((hostId: string) =>
      Promise.resolve(
        hostId === "box"
          ? [
              automation({
                hostId: "box",
                lastRun: {
                  id: "r1",
                  automationId: "a1",
                  scheduledFor: "2026-10-29T09:00:00.000Z",
                  firedAt: "2026-10-29T09:00:00.000Z",
                  trigger: "schedule",
                  outcome: "started",
                  status: "working",
                  paneId: "pane-r1",
                },
              }),
            ]
          : [],
      ),
    );
    await render();
    api.list.mockClear();
    await act(async () => {
      for (const cb of statusListeners) cb({ paneId: "pane-other" });
    });
    await settle();
    expect(api.list).not.toHaveBeenCalled();
    await act(async () => {
      for (const cb of statusListeners) {
        cb({ paneId: "pane-r1" });
        cb({ paneId: "pane-r1" });
      }
    });
    await settle();
    expect(api.list.mock.calls).toEqual([["box"]]);

    api.get.mockResolvedValue({ ...automation({ hostId: "box" }), runs: [] });
    await click(q("automations-row-a1"));
    api.list.mockClear();
    await act(async () => {
      for (const cb of statusListeners) cb({ paneId: "pane-r1" });
    });
    await settle();
    expect(api.list).not.toHaveBeenCalled();
  });

  it("says a host has no host server, and that one connecting is loading", async () => {
    useHostStore.setState({
      hosts: [
        ...HOSTS,
        { hostId: "old", spec: { kind: "ssh", target: "old-box" }, label: "old-box", status: "connected" },
        { hostId: "new", spec: { kind: "ssh", target: "new-box" }, label: "new-box", status: "connecting" },
      ],
      servers: {},
    });
    api.list.mockImplementation((hostId: string) =>
      hostId === "old"
        ? Promise.reject(Object.assign(new Error("nope"), { code: "unavailable:host" }))
        : Promise.resolve([]),
    );
    await render();
    expect(q("automations-host-old")?.textContent).toContain(
      "old-box has no Manor host server yet, so it can't run automations",
    );
    expect(q("automations-host-new")?.textContent).toContain("Loading…");
    expect(q("automations-host-new")?.textContent).not.toContain("Can't reach");
  });

  it("lists a custom schedule by its cron, and rows as buttons", async () => {
    api.list.mockImplementation((hostId: string) =>
      Promise.resolve(
        hostId === "box"
          ? [automation({ hostId: "box", schedule: { cron: "0 */6 * * 1-5", timezone: "UTC" } })]
          : [],
      ),
    );
    await render();
    const row = q("automations-row-a1");
    expect(row?.tagName).toBe("BUTTON");
    expect(row?.getAttribute("role")).toBeNull();
    expect(row?.textContent).toContain("0 */6 * * 1-5 · manor · Claude");
    expect(document.querySelector('[role="row"]')).toBeNull();
  });

  it("says Paused in place of a paused automation's next run", async () => {
    await render();
    const row = q("automations-row-a4");
    expect(row?.querySelector('[class*="pill"]')?.textContent).toBe("Paused");
  });

  it("opens on a given automation's page, or the list when its host has none", async () => {
    api.get.mockResolvedValue({ ...automation({ hostId: "box" }), runs: [] });
    await render({ hostId: "box", automationId: "a1" });
    expect(api.get).toHaveBeenCalledWith("box", "a1");
    expect((q("automation-name") as HTMLInputElement).value).toBe("Morning PR triage");

    act(() => root.unmount());
    root = createRoot(container);
    api.get.mockResolvedValue(null);
    await render({ hostId: "box", automationId: "gone" });
    expect(q("automation-detail")).toBeNull();
    expect(q("automations-page")).not.toBeNull();
  });

  it("opens on a new automation once a host can take one", async () => {
    await render("new");
    expect(q("automation-create")).not.toBeNull();
    expect(q("automation-chip-host")?.tagName).toBe("BUTTON");
  });
});
