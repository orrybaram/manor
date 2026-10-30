// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// `app-store` reads `window.electronAPI` at import time; jsdom's window has none.
vi.hoisted(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    claim: null,
    agents: { onUpdate: () => () => {} },
  };
});

import type { AgentInfo } from "../../../../electron.d";
import { useAgentStore } from "../../../../store/agent-store";
import { useAppStore } from "../../../../store/app-store";
import { readChatView, readStoredChatView, writeChatView } from "../chat-view";
import { paneHasChat, togglePaneChat } from "../pane-chat-toggle";
import {
  selectPaneChatView,
  startMenuHandoff,
  usePaneChatViewStore,
} from "../usePaneChatView";

const PANE = "pane-1";
const WS = "/repo/ws";
const TRANSCRIPT = "/tmp/t.jsonl";

function seedPane(contentType?: "file" | "browser"): void {
  useAppStore.setState({
    activeWorkspacePath: WS,
    activeWorkspaceHostId: "local",
    activeSurface: "workspace",
    viewports: {},
    workspaceLayouts: {
      [WS]: {
        panelTree: { type: "leaf", panelId: "panel-1" },
        panels: {
          "panel-1": {
            id: "panel-1",
            pinnedTabIds: [],
            tabs: [
              {
                id: "tab-1",
                title: "Claude",
                rootNode: { type: "leaf", paneId: PANE, ...(contentType && { contentType }) },
              },
            ],
          },
        },
      },
    },
  } as never);
}

function seedAgent(agent: Partial<AgentInfo> | null): void {
  useAgentStore.setState({
    agents: agent
      ? [
          {
            id: "agent-1",
            paneId: PANE,
            status: "active",
            agentKind: "claude",
            transcriptPath: TRANSCRIPT,
            createdAt: 1,
            ...agent,
          } as unknown as AgentInfo,
        ]
      : [],
  });
}

const deskView = () =>
  selectPaneChatView(usePaneChatViewStore.getState(), PANE, TRANSCRIPT, "desk");
const phoneView = () =>
  selectPaneChatView(usePaneChatViewStore.getState(), PANE, TRANSCRIPT, "phone");

beforeEach(() => {
  localStorage.clear();
  usePaneChatViewStore.setState({ views: {}, deskViews: {}, handoffs: {}, starting: {} });
  seedPane();
  seedAgent({});
});

describe("the stored view, per layout", () => {
  it("keeps the phone's and the desk's choices apart", () => {
    writeChatView(PANE, "chat", "desk");
    expect(readChatView(PANE, "desk")).toBe("chat");
    expect(readStoredChatView(PANE, "phone")).toBeNull();

    writeChatView(PANE, "terminal", "phone");
    expect(readChatView(PANE, "phone")).toBe("terminal");
    expect(readChatView(PANE, "desk")).toBe("chat");
  });

  it("defaults the phone to the chat and the desk to its caller's default", () => {
    expect(readChatView(PANE)).toBe("chat");
    expect(readChatView(PANE, "desk")).toBe("terminal");
    expect(readChatView(PANE, "desk", "chat")).toBe("chat");
  });
});

describe("togglePaneChat", () => {
  it("flips a desk pane from its terminal to the chat and back, leaving the phone alone", () => {
    expect(deskView()).toBe("terminal");
    togglePaneChat(PANE, "desk");
    expect(deskView()).toBe("chat");
    expect(readChatView(PANE, "desk")).toBe("chat");
    expect(phoneView()).toBe("chat");
    expect(readStoredChatView(PANE, "phone")).toBeNull();

    togglePaneChat(PANE, "desk");
    expect(deskView()).toBe("terminal");
  });

  it("does nothing for a pane with no chat", () => {
    for (const setup of [
      () => seedAgent(null),
      () => seedAgent({ agentKind: "codex" }),
      () => seedAgent({ transcriptPath: null }),
      () => seedPane("browser"),
    ]) {
      seedPane();
      seedAgent({});
      setup();
      expect(paneHasChat(PANE)).toBe(false);
      togglePaneChat(PANE, "desk");
      expect(usePaneChatViewStore.getState().deskViews).toEqual({});
    }
  });

  it("under a menu handoff, ends it and keeps the stored choice", () => {
    togglePaneChat(PANE, "desk");
    startMenuHandoff(PANE, "config", TRANSCRIPT);
    expect(deskView()).toBe("terminal");

    togglePaneChat(PANE, "desk");
    expect(usePaneChatViewStore.getState().handoffs).toEqual({});
    expect(deskView()).toBe("chat");
  });
});
