// @vitest-environment jsdom
/**
 * A tab's long-press menu on a phone: renaming the tab's agent or the
 * workspace, copying the branch, and closing the tab — each only when it
 * applies.
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `app-store`/`project-store` read `window.electronAPI` at import time.
vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    claim: null,
    agents: { onUpdate: () => () => {} },
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

import {
  PhoneRenameDialog,
  PhoneTabMenuContent,
  type PhoneRenameTarget,
} from "../PhoneTabMenu";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useAgentStore } from "../../../store/agent-store";
import type { AgentInfo } from "../../../electron.d";

const WS = "/repo/worktrees/my-workspace";
const PANE = "pane-1";

function seed(workspace: { name?: string; branch?: string; isMain?: boolean }): void {
  useProjectStore.setState({
    projects: [
      { id: "p1", workspaces: [{ path: WS, ...workspace }] } as unknown as ProjectInfo,
    ],
  });
  useAppStore.setState({
    activeWorkspacePath: WS,
    activeWorkspaceHostId: "local",
    activeSurface: "workspace",
    workspaceLayouts: {
      [WS]: {
        panelTree: { type: "leaf", panelId: "panel-1" },
        panels: {
          "panel-1": {
            id: "panel-1",
            pinnedTabIds: [],
            tabs: [{ id: "tab-1", title: "Terminal", rootNode: { type: "leaf", paneId: PANE } }],
          },
        },
      },
    },
  } as never);
}

/** The tab's menu as `TabButton` wires it on a phone. */
function Harness(props: { onClose: () => void }) {
  const [renaming, setRenaming] = useState<PhoneRenameTarget | null>(null);
  return createElement(
    ContextMenu.Root,
    null,
    createElement(
      ContextMenu.Trigger,
      { asChild: true },
      createElement("div", { "data-testid": "tab" }, "tab"),
    ),
    createElement(
      ContextMenu.Portal,
      null,
      createElement(PhoneTabMenuContent, {
        paneId: PANE,
        canClose: true,
        onClose: props.onClose,
        onRename: setRenaming,
        onCloseAutoFocus: () => {},
      }),
    ),
    renaming &&
      createElement(PhoneRenameDialog, { target: renaming, onDone: () => setRenaming(null) }),
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAgentStore.setState({ agents: [] });
});

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function render(onClose = () => {}): void {
  act(() => root.render(createElement(Harness, { onClose })));
}

/** A long-press reaches Radix as a `contextmenu` on the trigger. */
function openMenu(): void {
  act(() => {
    byTestId("tab")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
}

function select(testId: string): void {
  const el = byTestId(testId);
  if (!el) throw new Error(`no ${testId}`);
  act(() => el.click());
}

function type(value: string): void {
  const input = byTestId("phone-rename-input") as HTMLInputElement;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PhoneTabMenu", () => {
  it("renames the workspace from a dialog", () => {
    const renameWorkspace = vi.fn(async () => {});
    seed({ name: "old-name", branch: "feat/x" });
    useProjectStore.setState({ renameWorkspace });
    render();

    openMenu();
    select("phone-tab-rename-workspace");
    expect((byTestId("phone-rename-input") as HTMLInputElement).value).toBe("old-name");
    type("  new-name ");
    select("phone-rename-save");
    expect(renameWorkspace).toHaveBeenCalledWith("p1", WS, "new-name");
    expect(byTestId("phone-rename-dialog")).toBeNull();
  });

  it("does not offer renaming a project's main checkout", () => {
    seed({ isMain: true, branch: "main" });
    render();
    openMenu();
    expect(byTestId("phone-tab-menu")).not.toBeNull();
    expect(byTestId("phone-tab-rename-workspace")).toBeNull();
    expect(byTestId("phone-tab-copy-branch")).not.toBeNull();
  });

  it("renames the tab's agent, only when it has one", () => {
    const renameAgent = vi.fn(async () => {});
    seed({ name: "ws" });
    render();
    openMenu();
    expect(byTestId("phone-tab-rename-agent")).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    act(() =>
      useAgentStore.setState({
        renameAgent,
        agents: [
          {
            id: "agent-1",
            paneId: PANE,
            status: "active",
            agentKind: "codex",
            name: "fix bug",
            createdAt: 1,
          } as unknown as AgentInfo,
        ],
      }),
    );
    openMenu();
    select("phone-tab-rename-agent");
    expect((byTestId("phone-rename-input") as HTMLInputElement).value).toBe("fix bug");
    select("phone-rename-save");
    expect(renameAgent).toHaveBeenCalledWith("agent-1", "fix bug");
  });

  it("closes the tab", () => {
    const onClose = vi.fn();
    seed({ name: "ws" });
    render(onClose);
    openMenu();
    select("phone-tab-close");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
