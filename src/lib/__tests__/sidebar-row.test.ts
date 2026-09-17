// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  handleSidebarRowKeyDown,
  installRovingRows,
  syncRovingTabIndex,
  type SidebarRowKeyActions,
} from "../sidebar-row";
import { useAppStore } from "../../store/app-store";

function renderRows() {
  document.body.innerHTML = `
    <div id="sidebar">
      <div data-sidebar-row tabindex="-1" id="home">Home</div>
      <div data-sidebar-row tabindex="-1" id="project">Project</div>
      <div data-sidebar-row tabindex="-1" id="ws-a">a <button id="inner">PR</button></div>
      <div data-sidebar-row tabindex="-1" id="ws-b">b</div>
    </div>
    <button id="after">after</button>
  `;
}

const el = (id: string) => document.getElementById(id)!;
const activeId = () => (document.activeElement as HTMLElement | null)?.id;
const stops = () =>
  Array.from(document.querySelectorAll("[data-sidebar-row]"))
    .filter((row) => row.getAttribute("tabindex") === "0")
    .map((row) => row.id);

type KeyInit = {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: HTMLElement;
};

/** A minimal stand-in for React's keyboard event on `row`. */
function press(row: HTMLElement, init: KeyInit, actions: SidebarRowKeyActions) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = {
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...init,
    target: init.target ?? row,
    currentTarget: row,
    preventDefault,
    stopPropagation,
  } as unknown as ReactKeyboardEvent<HTMLElement>;
  handleSidebarRowKeyDown(event, actions);
  return { preventDefault, stopPropagation };
}

function actionsMock() {
  return {
    activate: vi.fn(),
    startRename: vi.fn(),
    setExpanded: vi.fn(),
    openMenu: vi.fn(),
  };
}

beforeEach(() => {
  renderRows();
});

describe("handleSidebarRowKeyDown", () => {
  it("Enter and Space activate the row", () => {
    const actions = actionsMock();
    const enter = press(el("ws-a"), { key: "Enter" }, actions);
    const space = press(el("ws-a"), { key: " " }, actions);
    expect(actions.activate).toHaveBeenCalledTimes(2);
    expect(actions.startRename).not.toHaveBeenCalled();
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(space.preventDefault).toHaveBeenCalled();
  });

  it("F2 renames, and does nothing on a row that can't be renamed", () => {
    const actions = actionsMock();
    press(el("ws-a"), { key: "F2" }, actions);
    expect(actions.startRename).toHaveBeenCalledTimes(1);

    const { preventDefault } = press(
      el("home"),
      { key: "F2" },
      { activate: vi.fn() },
    );
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("arrows move between rows; Home / End jump to the ends", () => {
    const actions = actionsMock();
    el("project").focus();
    press(el("project"), { key: "ArrowDown" }, actions);
    expect(activeId()).toBe("ws-a");
    press(el("ws-a"), { key: "ArrowUp" }, actions);
    expect(activeId()).toBe("project");
    press(el("project"), { key: "End" }, actions);
    expect(activeId()).toBe("ws-b");
    press(el("ws-b"), { key: "Home" }, actions);
    expect(activeId()).toBe("home");
  });

  it("← / → collapse and expand only when the row supports it", () => {
    const actions = actionsMock();
    press(el("project"), { key: "ArrowLeft" }, actions);
    press(el("project"), { key: "ArrowRight" }, actions);
    expect(actions.setExpanded.mock.calls).toEqual([[false], [true]]);

    const { preventDefault } = press(
      el("ws-a"),
      { key: "ArrowLeft" },
      { activate: vi.fn() },
    );
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Shift+F10, ContextMenu and ⌘. open the menu when a handler is given", () => {
    const actions = actionsMock();
    const shiftF10 = press(el("ws-a"), { key: "F10", shiftKey: true }, actions);
    press(el("ws-a"), { key: "ContextMenu" }, actions);
    press(el("ws-a"), { key: ".", metaKey: true }, actions);
    expect(actions.openMenu).toHaveBeenCalledTimes(3);
    expect(actions.openMenu).toHaveBeenCalledWith(el("ws-a"));
    // Handled locally, so the global shortcut dispatcher never sees it.
    expect(shiftF10.stopPropagation).toHaveBeenCalled();

    // ⌘⇧. (Copy Branch Name) must not be mistaken for ⌘. (open the menu).
    const copyBranch = press(
      el("ws-a"),
      { key: ".", metaKey: true, shiftKey: true },
      actions,
    );
    expect(actions.openMenu).toHaveBeenCalledTimes(3);
    expect(copyBranch.preventDefault).not.toHaveBeenCalled();

    const { preventDefault, stopPropagation } = press(
      el("ws-a"),
      { key: "F10", shiftKey: true },
      { activate: vi.fn() },
    );
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("leaves modified keys to app shortcuts", () => {
    const actions = actionsMock();
    el("ws-a").focus();
    const enter = press(el("ws-a"), { key: "Enter", metaKey: true }, actions);
    press(el("ws-a"), { key: "ArrowDown", ctrlKey: true }, actions);
    expect(actions.activate).not.toHaveBeenCalled();
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(activeId()).toBe("ws-a");
  });

  it("ignores keys aimed at something inside the row", () => {
    const actions = actionsMock();
    press(el("ws-a"), { key: "Enter", target: el("inner") }, actions);
    expect(actions.activate).not.toHaveBeenCalled();
  });

  it("Escape hands the keyboard back to the pane", () => {
    const refocusActivePane = vi.fn();
    useAppStore.setState({ refocusActivePane });
    el("ws-a").focus();
    press(el("ws-a"), { key: "Escape" }, actionsMock());
    expect(activeId()).not.toBe("ws-a");
    expect(refocusActivePane).toHaveBeenCalled();
  });
});

describe("roving tabindex", () => {
  it("puts the stop on the current row, else the first", () => {
    const root = el("sidebar");
    syncRovingTabIndex(root);
    expect(stops()).toEqual(["home"]);

    el("ws-b").setAttribute("aria-current", "true");
    syncRovingTabIndex(root);
    expect(stops()).toEqual(["ws-b"]);
  });

  it("moves the stop with focus and keeps a single Tab stop", async () => {
    const root = el("sidebar");
    el("ws-b").setAttribute("aria-current", "true");
    const dispose = installRovingRows(root);
    expect(stops()).toEqual(["ws-b"]);

    el("project").focus();
    expect(stops()).toEqual(["project"]);

    // Focus on something inside a row doesn't move the stop.
    el("inner").focus();
    expect(stops()).toEqual(["project"]);

    // The focused row going away hands the stop back to the current row.
    el("project").remove();
    await Promise.resolve();
    expect(stops()).toEqual(["ws-b"]);

    dispose();
  });

  it("follows the active row when it changes while focus is elsewhere", async () => {
    const root = el("sidebar");
    el("ws-b").setAttribute("aria-current", "true");
    const dispose = installRovingRows(root);

    el("ws-a").focus();
    expect(stops()).toEqual(["ws-a"]);
    el("after").focus();

    el("ws-b").removeAttribute("aria-current");
    el("home").setAttribute("aria-current", "true");
    await Promise.resolve();
    expect(stops()).toEqual(["home"]);

    dispose();
  });

  it("keeps the stop on the focused row when the active row changes under it", async () => {
    const root = el("sidebar");
    el("ws-b").setAttribute("aria-current", "true");
    const dispose = installRovingRows(root);

    el("ws-a").focus();
    el("ws-b").removeAttribute("aria-current");
    el("home").setAttribute("aria-current", "true");
    await Promise.resolve();
    expect(stops()).toEqual(["ws-a"]);

    dispose();
  });
});
