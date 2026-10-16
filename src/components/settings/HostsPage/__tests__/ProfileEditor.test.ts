// @vitest-environment jsdom
/**
 * ADR-235 D2: the Profiles section of Settings → Hosts, and the profile
 * editor (`StartHostForm` in profile mode).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProfile, TemplateCheck, TemplateInfo } from "../../../../electron.d";

const api = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const hosts = {
    listTemplates: vi.fn(),
    checkTemplate: vi.fn(),
    runTemplateFix: vi.fn(),
    list: () => new Promise(() => {}),
    onStatusChanged: () => () => {},
    onServerChanged: () => () => {},
    onPairingChanged: () => () => {},
  };
  const changed: { fn: (() => void) | null } = { fn: null };
  const hostProfiles = {
    list: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    onChanged: (cb: () => void) => {
      changed.fn = cb;
      return () => {};
    },
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { hosts, hostProfiles };
  return { hosts, hostProfiles, changed };
});

// This Mac's row is not under test and reads build-time globals.
vi.mock("../ThisMacRow", () => ({ ThisMacRow: () => null }));

import { SettingsNavContext } from "../../SettingsModal/settings-nav";
import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { HostsPage } from "../HostsPage";
import { useHostProfileStore, openProfileEditor } from "../../../../store/host-profile-store";
import { ProfileEditorDialog } from "../ProfileEditorDialog";
import { profileSummary } from "../host-settings-text";

const kubernetes: TemplateInfo = {
  id: "kubernetes",
  name: "Kubernetes cluster",
  description: "Pods on a cluster you have access to.",
  perHost: ["name"],
  fields: [
    { key: "name", label: "Pod name", default: "manor-abc", required: true },
    { key: "context", label: "Cluster", required: true },
    { key: "namespace", label: "Namespace", default: "manor", required: true, advanced: true },
  ],
};

const work: HostProfile = {
  id: "hp-1",
  name: "Work cluster",
  templateId: "kubernetes",
  values: { context: "prod", namespace: "manor" },
  idleStopMinutes: 120,
};

const ok = (id: string): TemplateCheck => ({ id, state: "ok", title: `${id} is fine` });

describe("profiles on the Hosts page", () => {
  let container: HTMLDivElement;
  let root: Root;

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = (el: HTMLElement | null) =>
    act(() => {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const flush = () => act(async () => {});
  const type = (el: HTMLElement | null, value: string) =>
    act(() => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  async function render(node: Parameters<typeof createElement>[0]) {
    await act(async () => {
      root.render(
        createElement(
          SettingsNavContext.Provider,
          { value: vi.fn() },
          createElement(TooltipProvider, null, createElement(node)),
        ),
      );
    });
    await flush();
  }

  beforeEach(() => {
    api.hosts.listTemplates.mockReset().mockResolvedValue([kubernetes]);
    api.hosts.checkTemplate.mockReset().mockResolvedValue({ checks: [ok("kubectl")], choices: {} });
    api.hostProfiles.list.mockReset().mockResolvedValue([work]);
    api.hostProfiles.save.mockReset();
    api.hostProfiles.remove.mockReset().mockResolvedValue(undefined);
    useHostProfileStore.setState({ profiles: [], editor: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists each profile with its template and where it points", async () => {
    await render(HostsPage);
    expect(q("host-profile-hp-1")?.textContent).toContain("Work cluster");
    expect(q("host-profile-hp-1")?.textContent).toContain("Kubernetes cluster · prod / manor");
    expect(profileSummary("Docker", {})).toBe("Docker");
  });

  it("lists again when main says profiles changed", async () => {
    await render(HostsPage);
    api.hostProfiles.list.mockResolvedValue([]);
    await act(async () => api.changed.fn?.());
    await flush();
    expect(q("host-profile-hp-1")).toBeNull();
  });

  it("saves a new profile without per-host fields, once every check is ok", async () => {
    api.hostProfiles.save.mockResolvedValue({ ...work, id: "hp-2" });
    const onSaved = vi.fn();
    await render(ProfileEditorDialog);
    act(() => openProfileEditor({ onSaved }));
    await flush();
    click(q("start-host-template"));
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (el) => el.textContent === kubernetes.name,
    );
    act(() => {
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flush();

    expect(q("start-host-field-name")).toBeNull();
    expect(q("start-host-field-context")).not.toBeNull();
    expect((q("profile-save") as HTMLButtonElement).disabled).toBe(true);
    type(q("profile-name"), "Home");
    type(q("start-host-field-context"), "kind");
    await flush();
    expect((q("profile-save") as HTMLButtonElement).disabled).toBe(false);

    click(q("profile-save"));
    await flush();
    expect(api.hostProfiles.save).toHaveBeenCalledWith({
      name: "Home",
      templateId: "kubernetes",
      values: { context: "kind", namespace: "manor" },
      idleStopMinutes: 60,
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "hp-2" }));
    expect(q("profile-editor")).toBeNull();
  });

  it("holds Save back while a check is not ok", async () => {
    api.hosts.checkTemplate.mockResolvedValue({
      checks: [{ id: "kubectl", state: "bad", title: "kubectl is missing" }],
      choices: {},
    });
    await render(ProfileEditorDialog);
    act(() => openProfileEditor({ profile: work }));
    await flush();
    expect((q("profile-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits a profile pre-filled, keeping its id", async () => {
    api.hostProfiles.save.mockResolvedValue(work);
    await render(ProfileEditorDialog);
    act(() => openProfileEditor({ profile: work }));
    await flush();
    expect((q("profile-name") as HTMLInputElement).value).toBe("Work cluster");
    expect((q("start-host-field-context") as HTMLInputElement).value).toBe("prod");
    click(q("profile-save"));
    await flush();
    expect(api.hostProfiles.save).toHaveBeenCalledWith({
      id: "hp-1",
      name: "Work cluster",
      templateId: "kubernetes",
      values: { context: "prod", namespace: "manor" },
      idleStopMinutes: 120,
    });
  });

  it("removes a profile only after confirming its hosts keep running", async () => {
    await render(HostsPage);
    click(q("host-profile-remove-hp-1"));
    await flush();
    expect(document.body.textContent).toContain(
      "Its hosts keep running. They'll no longer be grouped.",
    );
    expect(api.hostProfiles.remove).not.toHaveBeenCalled();
    const confirm = Array.from(document.querySelectorAll<HTMLElement>("button")).find(
      (b) => b.textContent === "Remove",
    );
    click(confirm ?? null);
    await flush();
    expect(api.hostProfiles.remove).toHaveBeenCalledWith("hp-1");
  });
});
