// @vitest-environment jsdom
/**
 * The phone new-agent composer's target chips. The host chip
 * shows only for a project linked across hosts, picking a chip choice moves
 * the target, and the worktree toggle rewrites the greeting.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    claim: null,
    github: { getViewerName: () => Promise.resolve(null) },
    agents: { onUpdate: () => () => {} },
  };
});

const { uploadPastedImage, sendNewAgent } = vi.hoisted(() => ({
  uploadPastedImage: vi.fn(),
  sendNewAgent: vi.fn(),
}));
// The send path (launches, worktrees) is out of scope here.
vi.mock("../send-new-agent", () => ({ sendNewAgent }));
vi.mock("../../../../lib/paste-image-upload", () => ({ uploadPastedImage }));

import type { ProjectGroupInfo, ProjectInfo } from "../../../../store/project-store";
import { useProjectStore } from "../../../../store/project-store";
import { useAppStore } from "../../../../store/app-store";
import { useHostStore } from "../../../../store/host-store";
import { useAgentStore } from "../../../../store/agent-store";
import { PhoneNewAgentComposer } from "../PhoneNewAgentComposer";

function project(
  id: string,
  hostId: string,
  group: ProjectGroupInfo | null,
  extra: { path: string; branch: string }[] = [],
): ProjectInfo {
  return {
    id,
    name: id,
    path: `/code/${id}`,
    hostId,
    defaultBranch: "main",
    workspaces: [
      { path: `/code/${id}`, branch: "main", isMain: true, name: null },
      ...extra.map((e) => ({ path: e.path, branch: e.branch, isMain: false, name: null })),
    ],
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color: null,
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
    portlessEnabled: true,
    folders: [],
    sidebarOrder: [],
    group,
  };
}

const linked: ProjectGroupInfo = {
  id: "g1",
  name: "App",
  memberIds: ["local-app", "box-app"],
  lastUsedHostId: null,
};
const solo = project("solo", "local", null, [{ path: "/wt/feat", branch: "feat" }]);
const localApp = project("local-app", "local", linked);
const boxApp = project("box-app", "box", linked);

let container: HTMLDivElement;
let root: Root;

function one(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function all(testId: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function render(closable = true): Promise<void> {
  await act(async () => {
    root.render(createElement(PhoneNewAgentComposer, { closable }));
  });
}

function activate(path: string, hostId = "local"): void {
  useAppStore.setState({ activeWorkspacePath: path, activeWorkspaceHostId: hostId });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useProjectStore.setState({ projects: [solo, localApp, boxApp] });
  useHostStore.setState({ hosts: [] });
  useAgentStore.setState({ agents: [] });
  useAppStore.setState({ composerDraft: { text: "", target: null } });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("PhoneNewAgentComposer — chips", () => {
  it("hides the host chip for a project on one host", async () => {
    activate("/code/solo");
    await render();

    expect(one("phone-target-chips")).not.toBeNull();
    expect(one("phone-target-host")).toBeNull();
    expect(one("phone-target-project")?.textContent).toContain("solo");
    expect(one("phone-target-workspace")?.textContent).toContain("main");
  });

  it("shows the host chip for a linked group, and lists its hosts", async () => {
    activate("/code/local-app");
    await render();

    const host = one("phone-target-host");
    expect(host?.textContent).toContain("This machine");
    expect(one("phone-target-project")?.textContent).toContain("App");

    await click(host);
    const rows = all("phone-target-choice");
    expect(rows.map((r) => r.textContent)).toEqual(["This machine", "box"]);
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
  });

  it("picks a workspace from the list and keeps it in the draft", async () => {
    activate("/code/solo");
    await render();

    await click(one("phone-target-workspace"));
    expect(one("phone-target-choices")).not.toBeNull();
    const feat = all("phone-target-choice").find((r) => r.textContent?.includes("feat"));
    await click(feat);

    expect(one("phone-target-choices")).toBeNull();
    expect(one("phone-target-workspace")?.textContent).toContain("feat");
    expect(useAppStore.getState().composerDraft.target).toEqual({
      projectId: "solo",
      workspacePath: "/wt/feat",
      newWorktree: false,
    });
  });

  it("the empty-workspace screen follows its workspace, not a target picked elsewhere", async () => {
    activate("/code/solo");
    useAppStore.setState({
      composerDraft: {
        text: "",
        target: { projectId: "local-app", workspacePath: "/code/local-app", newWorktree: false },
      },
    });
    await render(false);

    expect(one("phone-target-project")?.textContent).toContain("solo");
    expect(one("phone-composer-close")).toBeNull();
  });

  it("the empty-workspace screen keeps its own pick out of the draft", async () => {
    activate("/code/solo");
    await render(false);

    await click(one("phone-target-worktree"));

    expect(one("phone-composer-subline")?.textContent).toContain("new worktree off main");
    expect(useAppStore.getState().composerDraft.target).toBeNull();
  });
});

describe("PhoneNewAgentComposer — greeting", () => {
  it("names the target, then the worktree it will start once toggled", async () => {
    activate("/code/solo");
    await render();

    const subline = () => one("phone-composer-subline")?.textContent ?? "";
    expect(subline()).toContain("Claude is ready in solo on main.");

    await click(one("phone-target-worktree"));

    expect(subline()).toContain("Claude will start a new worktree off main.");
    expect(useAppStore.getState().composerDraft.target?.newWorktree).toBe(true);
  });

  it("closes back to the workspace from the close button", async () => {
    activate("/code/solo");
    useAppStore.setState({ activeSurface: "composer" });
    await render();

    await click(one("phone-composer-close"));

    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });
});

describe("PhoneNewAgentComposer — images", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:image");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    uploadPastedImage.mockReset();
    sendNewAgent.mockReset();
  });

  async function pick(file: File): Promise<void> {
    const input = one("chat-attach-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  const png = () => new File([new Uint8Array([1])], "a.png", { type: "image/png" });

  it("uploads a picked image to the target's host and shows it as a thumbnail", async () => {
    uploadPastedImage.mockResolvedValue("/home/me/.manor/pasted-images/a.png");
    activate("/code/box-app", "box");
    useAppStore.setState({ composerDraft: { text: "look at this", target: null } });
    await render();

    const file = png();
    await pick(file);

    expect(uploadPastedImage).toHaveBeenCalledWith(expect.stringMatching(/^pane-/), file, {
      hostId: "box",
      signal: expect.any(AbortSignal),
    });
    expect(all("image-attachment")).toHaveLength(1);
    expect(useAppStore.getState().composerDraft.text).toBe("look at this");

    await click(one("phone-empty-send"));
    expect(sendNewAgent).toHaveBeenCalledWith(
      "look at this /home/me/.manor/pasted-images/a.png",
      expect.anything(),
    );
    expect(all("image-attachment")).toHaveLength(0);
  });

  it("starts an agent from images alone", async () => {
    uploadPastedImage.mockResolvedValue("/tmp/a.png");
    activate("/code/solo");
    await render();
    expect((one("phone-empty-send") as HTMLButtonElement).disabled).toBe(true);

    await pick(png());
    expect((one("phone-empty-send") as HTMLButtonElement).disabled).toBe(false);
    await click(one("phone-empty-send"));
    expect(sendNewAgent).toHaveBeenCalledWith("/tmp/a.png", expect.anything());
  });

  it("uploads the images again when the target moves to another host", async () => {
    uploadPastedImage.mockImplementation((_pane, _file, opts: { hostId: string }) =>
      Promise.resolve(`/${opts.hostId}/a.png`),
    );
    activate("/code/box-app", "box");
    await render(false);
    await pick(png());

    activate("/code/solo");
    await render(false);
    expect(uploadPastedImage).toHaveBeenLastCalledWith(expect.any(String), expect.any(File), {
      hostId: "local",
      signal: expect.any(AbortSignal),
    });
    await click(one("phone-empty-send"));
    expect(sendNewAgent).toHaveBeenCalledWith("/local/a.png", expect.anything());
  });
});
