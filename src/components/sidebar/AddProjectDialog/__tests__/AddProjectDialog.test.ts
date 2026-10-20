// @vitest-environment jsdom
/**
 * Add Project → Clone repository offers "In a new pod" after the
 * hosts, hides Location for it, and submits through `openInNewHost`.
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
  (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView ??= () => {};
  const projects = {
    getAll: vi.fn(() => Promise.resolve([])),
    getSelectedIndex: vi.fn(() => Promise.resolve(0)),
    onCloneProgress: vi.fn(() => () => {}),
    openInNewHost: vi.fn(),
    clone: vi.fn(),
  };
  const hosts = {
    list: () => new Promise(() => {}),
    onStatusChanged: () => () => {},
    onServerChanged: () => () => {},
    onPairingChanged: () => () => {},
    healthCheck: vi.fn(() => Promise.resolve([])),
  };
  const github = { listRepos: vi.fn(() => Promise.resolve([])) };
  (window as unknown as { electronAPI: unknown }).electronAPI = { projects, hosts, github };
  return projects;
});

vi.mock("../../../../store/auto-join", () => ({
  runAutoJoin: vi.fn(async () => {}),
  startAutoJoin: vi.fn(async () => {}),
}));

import { useHostProfileStore } from "../../../../store/host-profile-store";
import { useProjectStore } from "../../../../store/project-store";
import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { AddProjectDialog } from "../AddProjectDialog";

const profiles = [
  { id: "hp-1", name: "Work cluster", templateId: "kubernetes", values: {} },
  { id: "hp-2", name: "Laptop", templateId: "docker", values: {} },
];

describe("AddProjectDialog in a new pod", () => {
  let container: HTMLDivElement;
  let root: Root;

  const byId = (id: string) => document.getElementById(id);
  const click = (el: Element | null | undefined) =>
    act(() => {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const pick = (el: Element | null | undefined) =>
    act(() => {
      el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
  const type = (el: HTMLElement | null, value: string) =>
    act(() => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const optionNamed = (text: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes(text),
    );

  async function render() {
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AddProjectDialog, {
            open: true,
            initialMode: "clone",
            onClose: vi.fn(),
            onAddLocal: vi.fn(),
          }),
        ),
      );
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useHostProfileStore.setState({ profiles, editor: null });
    useProjectStore.setState({ projects: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists a pod or container option per profile after the hosts", async () => {
    await render();
    await click(byId("add-project-host"));

    expect(optionNamed("In a new pod · Work cluster")).toBeTruthy();
    expect(optionNamed("In a new container · Laptop")).toBeTruthy();
  });

  it("hides Location for a new pod and submits through openInNewHost", async () => {
    api.openInNewHost.mockResolvedValue({ ok: false, stage: "up", hostId: "pod-1", error: "x" });
    await render();
    expect(byId("add-project-location")).toBeTruthy();

    await click(byId("add-project-host"));
    await pick(optionNamed("In a new pod · Work cluster"));
    expect(byId("add-project-location")).toBeNull();

    await type(byId("add-project-repo-url"), "git@github.com:me/app.git");
    const clone = [...document.querySelectorAll("button")].find((b) => b.textContent === "Clone");
    await click(clone);

    expect(api.openInNewHost).toHaveBeenCalledWith({
      profileId: "hp-1",
      repoUrl: "git@github.com:me/app.git",
    });
    expect(api.clone).not.toHaveBeenCalled();
  });

  it("offers In a new pod… when there are no profiles, opening the editor", async () => {
    useHostProfileStore.setState({ profiles: [] });
    await render();
    await click(byId("add-project-host"));
    await pick(optionNamed("In a new pod…"));

    expect(useHostProfileStore.getState().editor).not.toBeNull();
  });
});
