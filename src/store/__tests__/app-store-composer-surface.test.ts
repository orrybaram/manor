import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";
import type { WorkspaceLayout } from "../app-store";
import { resetFakeLayoutServer, seedLayout } from "./fake-layout-server";

const WS_PATH = "/test/workspace";

function makeLayout(): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs: [
          { id: "tab-1", title: "Terminal", rootNode: { type: "leaf", paneId: "pane-1" } },
        ],
        pinnedTabIds: [],
      },
    },
  };
}

beforeEach(() => {
  const layout = makeLayout();
  resetFakeLayoutServer();
  seedLayout(WS_PATH, layout);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    activeWorkspaceHostId: "local",
    activeSurface: "workspace",
    workspaceLayouts: { [WS_PATH]: layout },
    viewports: {},
    claims: {},
    composerDraft: { text: "", target: null },
  });
});

describe("composer surface (ADR-222)", () => {
  it("showComposer / closeComposer toggle the surface, keeping the workspace", () => {
    useAppStore.getState().showComposer();
    expect(useAppStore.getState().activeSurface).toBe("composer");
    expect(useAppStore.getState().activeWorkspacePath).toBe(WS_PATH);
    useAppStore.getState().closeComposer();
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });

  it("setActiveWorkspace resets it", () => {
    useAppStore.getState().showComposer();
    useAppStore.getState().setActiveWorkspace(WS_PATH);
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });

  it("selectTab resets it", () => {
    useAppStore.getState().showComposer();
    useAppStore.getState().selectTab("tab-1");
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });
});

describe("composerDraft (ADR-222)", () => {
  it("merges patches and clears", () => {
    const target = { projectId: "p", workspacePath: "/w", newWorktree: true };
    useAppStore.getState().setComposerDraft({ text: "hi" });
    useAppStore.getState().setComposerDraft({ target });
    expect(useAppStore.getState().composerDraft).toEqual({ text: "hi", target });
    useAppStore.getState().clearComposerDraft();
    expect(useAppStore.getState().composerDraft).toEqual({ text: "", target: null });
  });

  it("survives closing the composer", () => {
    useAppStore.getState().showComposer();
    useAppStore.getState().setComposerDraft({ text: "keep" });
    useAppStore.getState().closeComposer();
    expect(useAppStore.getState().composerDraft.text).toBe("keep");
  });
});
