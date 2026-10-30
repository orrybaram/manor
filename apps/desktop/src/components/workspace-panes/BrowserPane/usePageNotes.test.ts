// @vitest-environment jsdom
/**
 * `usePageNotes`: each pick the page reports becomes a numbered note whose
 * pin the page is told to draw; Send uploads each screenshot to the
 * workspace's host and delivers one prompt citing those paths, then the
 * queue and its pins are gone.
 */
import { act, createElement, createRef, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../../electron.d";
import type { PagePick } from "../../../../electron/webview-pins";
import { workspaceKey } from "../../../lib/workspace-key";
import { usePageNotes, type PageNotes } from "./usePageNotes";

const sendPromptToAgent = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));
vi.mock("../../../lib/agent-send", () => ({ sendPromptToAgent }));

type Handler = (...args: never[]) => void;
const handlers: Record<string, Handler> = {};
const on = (name: string) => (cb: Handler) => {
  handlers[name] = cb;
  return () => delete handlers[name];
};
const webview = {
  syncPins: vi.fn(async () => {}),
  startPins: vi.fn(async () => true),
  stopPins: vi.fn(async () => {}),
  uploadPinShot: vi.fn(async (id: string, hostId: string) => `/home/box/.manor/pasted-images/${id}-${hostId}.png`),
  onPinPicked: on("picked"),
  onPinsStopped: on("stopped"),
  onPinOpened: on("opened"),
  onPinsMoved: on("moved"),
};
(window as unknown as Record<string, unknown>).electronAPI = {
  ...(window.electronAPI as unknown as Record<string, unknown>),
  webview,
  clipboard: { writeText: vi.fn() },
};

const pick = (id: string, over: Partial<PagePick> = {}): PagePick => ({
  pickId: id,
  selector: `div.card:nth-child(${id})`,
  outerHTML: `<div class="card">${id}</div>`,
  computedStyles: {},
  boundingBox: { x: 0, y: 0, width: 10, height: 10 },
  accessibility: {},
  screenshot: { id: `shot-${id}`, path: `/home/me/.manor/pasted-images/${id}.png` },
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const probe: { current: PageNotes | null } = { current: null };
const onPickingChange = vi.fn();
let picking = true;

function Probe() {
  const webviewRef = createRef<HTMLElement>();
  const notes = usePageNotes({
    paneId: "pane-1",
    webviewRef,
    workspaceKey: workspaceKey("box", "/repo/ws"),
    pageUrl: () => "http://localhost:3000/",
    isPicking: () => picking,
    onPickingChange,
  });
  useEffect(() => {
    probe.current = notes;
  });
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  picking = true;
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root.unmount());
});

const latestNotes = () => probe.current!;

describe("usePageNotes", () => {
  it("queues picks in order, opens each note, and numbers their pins", () => {
    act(() => {
      (handlers.picked as (p: string, k: PagePick) => void)("pane-1", pick("1"));
      (handlers.picked as (p: string, k: PagePick) => void)("other-pane", pick("x"));
      (handlers.picked as (p: string, k: PagePick) => void)("pane-1", pick("2"));
    });
    expect(latestNotes().notes.map((n) => n.id)).toEqual(["1", "2"]);
    expect(latestNotes().notes[0].url).toBe("http://localhost:3000/");
    expect(latestNotes().openId).toBe("2");
    expect(webview.syncPins).toHaveBeenLastCalledWith("pane-1", [
      { id: "1", label: "1" },
      { id: "2", label: "2" },
    ]);

    // Typing a note doesn't redraw the pins.
    const syncs = webview.syncPins.mock.calls.length;
    act(() => latestNotes().setNote("1", "Too tall"));
    expect(latestNotes().notes[0].note).toBe("Too tall");
    expect(webview.syncPins.mock.calls.length).toBe(syncs);
  });

  it("ends picking when the page says Escape", () => {
    act(() => (handlers.stopped as (p: string) => void)("pane-1"));
    expect(onPickingChange).toHaveBeenCalledWith(false);
  });

  it("sends one prompt citing each screenshot on the workspace's host, then empties", async () => {
    act(() => {
      for (const id of ["1", "2", "3"]) (handlers.picked as (p: string, k: PagePick) => void)("pane-1", pick(id));
    });
    act(() => latestNotes().setNote("1", "Show seats used"));

    const target = { kind: "agent", agent: { id: "a", paneId: "pane-a" } as AgentInfo } as const;
    await act(() => latestNotes().send(target));

    expect(webview.uploadPinShot.mock.calls).toEqual([
      ["shot-1", "box"],
      ["shot-2", "box"],
      ["shot-3", "box"],
    ]);
    expect(sendPromptToAgent).toHaveBeenCalledTimes(1);
    const [workspacePath, prompt, sentTo, opts] = sendPromptToAgent.mock.calls[0] as [string, string, unknown, unknown];
    expect(workspacePath).toBe("/repo/ws");
    expect(sentTo).toBe(target);
    expect(opts).toMatchObject({ what: "3 notes", hostId: "box" });
    expect(prompt).toContain("[1] div.card:nth-child(1) — Show seats used");
    expect(prompt).toContain("Screenshot: /home/box/.manor/pasted-images/shot-3-box.png");
    expect(prompt.match(/Screenshot: /g)).toHaveLength(3);

    expect(latestNotes().notes).toEqual([]);
    expect(webview.syncPins).toHaveBeenLastCalledWith("pane-1", []);
  });

  it("copies citing the screenshots on the workspace's host, and keeps the queue", async () => {
    act(() => (handlers.picked as (p: string, k: PagePick) => void)("pane-1", pick("1")));
    await act(() => latestNotes().copy());
    expect(webview.uploadPinShot).toHaveBeenCalledWith("shot-1", "box");
    const text = (window.electronAPI.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(text).toContain("Screenshot: /home/box/.manor/pasted-images/shot-1-box.png");
    expect(latestNotes().notes).toHaveLength(1);
  });

  it("keeps the notes when the send didn't go", async () => {
    act(() => (handlers.picked as (p: string, k: PagePick) => void)("pane-1", pick("1")));
    sendPromptToAgent.mockReturnValueOnce(false);
    await act(() => latestNotes().send({ kind: "new" }));
    expect(sendPromptToAgent).toHaveBeenCalledTimes(1);
    expect(latestNotes().notes).toHaveLength(1);
  });

  it("opens a note only for a pick made while armed, or a pin it holds", () => {
    picking = false;
    act(() => (handlers.picked as (p: string, k: PagePick) => void)("pane-1", pick("1")));
    expect(latestNotes().openId).toBeNull();
    act(() => (handlers.opened as (p: string, id: string) => void)("pane-1", "not-a-pin"));
    expect(latestNotes().openId).toBeNull();
    act(() => (handlers.opened as (p: string, id: string) => void)("pane-1", "1"));
    expect(latestNotes().openId).toBe("1");
  });
});
