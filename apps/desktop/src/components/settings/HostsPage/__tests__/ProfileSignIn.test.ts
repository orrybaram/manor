// @vitest-environment jsdom
/** The "Sign new pods in for me" section of the profile editor. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProfile, TemplateInfo } from "../../../../electron.d";

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
    // The host store, for the running-pod count.
    list: () => new Promise(() => {}),
    onStatusChanged: () => () => {},
    onServerChanged: () => () => {},
    onPairingChanged: () => () => {},
  };
  const hostProfiles = {
    list: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    setSignIn: vi.fn(),
    removeSignIn: vi.fn(),
    restartPods: vi.fn(),
    onChanged: () => () => {},
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { hosts, hostProfiles };
  return { hosts, hostProfiles };
});

import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { openProfileEditor, useHostProfileStore } from "../../../../store/host-profile-store";
import { ProfileEditorDialog } from "../ProfileEditorDialog";
import { signInStatusText } from "../host-settings-text";

const template = (id: string): TemplateInfo => ({
  id,
  name: id,
  description: "",
  perHost: ["name"],
  fields: [{ key: "namespace", label: "Namespace", default: "team-a", required: true }],
});

const profile: HostProfile = {
  id: "hp-1",
  name: "Work cluster",
  templateId: "kubernetes",
  values: { namespace: "team-a" },
};

describe("profile sign-in section", () => {
  let container: HTMLDivElement;
  let root: Root;

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = (el: Element | null | undefined) =>
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

  async function open(p: HostProfile | undefined, templateId = "kubernetes") {
    api.hosts.listTemplates.mockResolvedValue([template(templateId)]);
    await act(async () => {
      root.render(createElement(TooltipProvider, null, createElement(ProfileEditorDialog)));
    });
    act(() => openProfileEditor({ profile: p }));
    await flush();
  }

  beforeEach(() => {
    api.hosts.checkTemplate.mockReset().mockResolvedValue({ checks: [], choices: {} });
    api.hostProfiles.setSignIn.mockReset();
    api.hostProfiles.removeSignIn.mockReset();
    api.hostProfiles.restartPods.mockReset();
    useHostProfileStore.setState({ profiles: [], editor: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("is absent for a new profile and for a Docker profile", async () => {
    await open(undefined);
    expect(q("profile-signin")).toBeNull();
    act(() => useHostProfileStore.getState().closeEditor());
    await open({ ...profile, templateId: "docker" }, "docker");
    expect(q("profile-signin")).toBeNull();
  });

  it("is off by default, and shows the warning while on", async () => {
    await open(profile);
    expect(q("signin-warning")).toBeNull();
    click(q("signin-toggle"));
    expect(q("signin-warning")?.textContent).toContain("Secrets in team-a");
  });

  it("sets the computer's GitHub sign-in, then offers a restart", async () => {
    api.hostProfiles.setSignIn.mockResolvedValue({
      ...profile,
      signIn: { github: { setAt: 1_700_000_000_000, source: "gh" } },
    });
    api.hostProfiles.restartPods.mockResolvedValue({ restarted: ["a-0", "b-0"] });
    await open(profile);
    click(q("signin-toggle"));
    click(q("signin-github-set"));
    await flush();
    expect(api.hostProfiles.setSignIn).toHaveBeenCalledWith("hp-1", { github: { source: "gh" } });
    expect(q("signin-github-status")?.textContent).toContain(
      signInStatusText({ setAt: 1_700_000_000_000, source: "gh" }),
    );
    expect(q("signin-github-status")?.textContent).toContain("from this computer");
    expect(q("signin-restart")?.textContent).toContain("Restart running pods to use it");

    click(q("signin-restart-button"));
    await flush();
    expect(api.hostProfiles.restartPods).toHaveBeenCalledWith("hp-1");
    expect(q("signin-restart")?.textContent).toContain("Restarted 2 pods");
  });

  it("sends a pasted token and clears the input", async () => {
    api.hostProfiles.setSignIn.mockResolvedValue({
      ...profile,
      signIn: { claude: { setAt: 1_700_000_000_000, source: "pasted" } },
    });
    await open(profile);
    click(q("signin-toggle"));
    expect((q("signin-claude-token") as HTMLInputElement).type).toBe("password");
    expect((q("signin-claude-set") as HTMLButtonElement).disabled).toBe(true);
    type(q("signin-claude-token"), " sk-claude ");
    click(q("signin-claude-set"));
    await flush();
    expect(api.hostProfiles.setSignIn).toHaveBeenCalledWith("hp-1", {
      claude: { token: "sk-claude" },
    });
    // The input goes with the set token, and Replace brings it back empty.
    expect(q("signin-claude-token")).toBeNull();
    click(q("signin-claude-replace"));
    expect((q("signin-claude-token") as HTMLInputElement).value).toBe("");
  });

  it("pastes a GitHub token through a password input", async () => {
    api.hostProfiles.setSignIn.mockResolvedValue({
      ...profile,
      signIn: { github: { setAt: 1, source: "pasted" } },
    });
    await open(profile);
    click(q("signin-toggle"));
    click(q("signin-github-source")?.querySelectorAll("button")[1]);
    expect((q("signin-github-token") as HTMLInputElement).type).toBe("password");
    type(q("signin-github-token"), "ghp_x");
    click(q("signin-github-set"));
    await flush();
    expect(api.hostProfiles.setSignIn).toHaveBeenCalledWith("hp-1", {
      github: { source: "pasted", token: "ghp_x" },
    });
  });

  it("removes a token, and shows a failure", async () => {
    const set = { ...profile, signIn: { claude: { setAt: 1, source: "pasted" as const } } };
    api.hostProfiles.removeSignIn.mockRejectedValueOnce(new Error("kubectl failed"));
    await open(set);
    click(q("signin-claude-remove"));
    await flush();
    expect(q("signin-error")?.textContent).toContain("kubectl failed");
    expect(q("signin-claude-status")).not.toBeNull();

    api.hostProfiles.removeSignIn.mockResolvedValueOnce(profile);
    click(q("signin-claude-remove"));
    await flush();
    expect(api.hostProfiles.removeSignIn).toHaveBeenCalledWith("hp-1", "claude");
    expect(q("signin-claude-status")).toBeNull();
    expect(q("signin-restart")).not.toBeNull();
  });

  it("follows the profile as the store refreshes it while open", async () => {
    useHostProfileStore.setState({ profiles: [profile] });
    await open(profile);
    expect(q("signin-claude-status")).toBeNull();
    act(() =>
      useHostProfileStore.setState({
        profiles: [{ ...profile, signIn: { claude: { setAt: 1, source: "pasted" } } }],
      }),
    );
    expect(q("signin-claude-status")).not.toBeNull();
    expect(q("signin-warning")).not.toBeNull();
  });
});
