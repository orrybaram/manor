// @vitest-environment jsdom
/**
 * The phone chat's window over a long history: the newest items mount,
 * nearing the top mounts earlier ones with the place kept, entries landing
 * while scrolled up leave the top alone, and the bottom drops back to the
 * newest. jsdom has no layout, so each entry is given a height of `ROW_PX`
 * and the scroller a height of `VIEW_PX`, and a scroll offset past the end
 * clamps, as a browser's does.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null };
});

import type { ChatEntry, ChatPush } from "../../../../electron.d";
import { ChatPane } from "../ChatPane";
import { EARLIER_ITEMS, WINDOW_ITEMS } from "../chat-window";

const PANE = "pane-window";
const ROW_PX = 40;
const VIEW_PX = 800;

const user = (id: string): ChatEntry => ({ kind: "user", id, ts: "", text: id });
const history = (n: number) => Array.from({ length: n }, (_, i) => user(`h${i}`));

let container: HTMLDivElement;
let root: Root;
let push: ((paneId: string, entry: ChatPush) => void) | null;

async function open(entries: ChatEntry[]): Promise<void> {
  const chat = {
    getHistory: vi.fn(() => Promise.resolve({ ok: true, entries, contextTokens: null })),
    onEntry: vi.fn((_paneId: string, cb: typeof push) => {
      push = cb;
      return () => {
        push = null;
      };
    }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null, chat };
  await act(async () => {
    root.render(
      createElement(ChatPane, { paneId: PANE, transcript: "/t/w.jsonl", hidden: false, onShowTerminal: () => {} }),
    );
  });  // The chat opens at the bottom, which is a scroll like any other.
  await scrollTo(Number.MAX_SAFE_INTEGER);
}

function mounted(): string[] {
  return [...container.querySelectorAll('[data-testid="chat-user"]')].map((el) => el.textContent ?? "");
}

/** The scroller, given a layout: each mounted entry is `ROW_PX` tall. */
function scroller(): HTMLElement {
  const content = container.querySelector('[data-chat-pane] [class*="entries"]') as HTMLElement;
  const el = content.parentElement as HTMLElement;
  if (!("fake" in el.dataset)) {
    el.dataset.fake = "";
    let top = 0;
    const clamp = (v: number) => Math.max(0, Math.min(v, content.children.length * ROW_PX - VIEW_PX));
    Object.defineProperties(el, {
      clientHeight: { get: () => VIEW_PX },
      scrollHeight: { get: () => content.children.length * ROW_PX },
      scrollTop: {
        get: () => (top = clamp(top)),
        set: (v: number) => {
          top = clamp(v);
        },
      },
    });
  }
  return el;
}

async function scrollTo(top: number): Promise<void> {
  const el = scroller();
  await act(async () => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

/** The px from the scroller's top to entry `id`, as the user sees it. */
function onScreen(id: string): number {
  return mounted().indexOf(id) * ROW_PX - scroller().scrollTop;
}

async function pushUser(id: string): Promise<void> {
  await act(async () => push?.(PANE, user(id)));
}

const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset.itemId === undefined || !this.parentElement) return 0;
      return [...this.parentElement.children].indexOf(this) * ROW_PX;
    },
  });
});

afterAll(() => {
  if (offsetTop) Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop);
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// Slow, not stuck: the fake layout walks the list for every offset.
describe("the chat's window", { timeout: 30_000 }, () => {
  it("mounts only the newest items of a long history", async () => {
    await open(history(400));
    const shown = mounted();
    expect(shown).toHaveLength(WINDOW_ITEMS);
    expect(shown[shown.length - 1]).toBe("h399");
  });

  it("mounts everything when the history is short", async () => {
    await open(history(40));
    expect(mounted()).toHaveLength(40);
  });

  it("mounts earlier items near the top, and keeps what the user sees in place", async () => {
    await open(history(400));
    const bottom = scroller().scrollTop;
    await scrollTo(bottom - 200); // leave the bottom
    await scrollTo(300); // within a screen of the top
    expect(mounted()).toHaveLength(WINDOW_ITEMS + EARLIER_ITEMS);
    // h250 was the first mounted item, 300px above the view; it still is.
    expect(onScreen("h250")).toBe(-300);
  });

  it("keeps the place when an entry lands as earlier items load", async () => {
    await open(history(400));
    await scrollTo(scroller().scrollTop - 200);
    const el = scroller();
    await act(async () => {
      el.scrollTop = 300;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      push?.(PANE, user("landed"));
    });
    expect(onScreen("h250")).toBe(-300);
  });

  it("keeps what's on screen in place as the top trims at the bottom", async () => {
    await open(history(400));
    const before = onScreen("h399");
    await pushUser("new");
    expect(mounted()).toHaveLength(WINDOW_ITEMS);
    // Follow-bottom (no ResizeObserver in jsdom) then scrolls on from here.
    expect(onScreen("h399")).toBe(before);
  });

  it("keeps loading until the first item is mounted", async () => {
    await open(history(400));
    await scrollTo(scroller().scrollTop - 200);
    for (let i = 0; i < 5; i++) await scrollTo(0);
    expect(mounted()).toHaveLength(400);
    expect(mounted()[0]).toBe("h0");
  });

  it("leaves the top alone while entries land and the user is scrolled up", async () => {
    await open(history(400));
    await scrollTo(scroller().scrollTop - 2000);
    const first = mounted()[0];
    const top = scroller().scrollTop;
    for (let i = 0; i < 20; i++) await pushUser(`live${i}`);
    expect(mounted()[0]).toBe(first);
    expect(scroller().scrollTop).toBe(top);
  });

  it("drops back to the newest items at the bottom", async () => {
    await open(history(400));
    await scrollTo(scroller().scrollTop - 200);
    await scrollTo(300);
    expect(mounted()).toHaveLength(WINDOW_ITEMS + EARLIER_ITEMS);
    await scrollTo(scroller().scrollHeight);
    expect(mounted()).toHaveLength(WINDOW_ITEMS);
    expect(mounted()[WINDOW_ITEMS - 1]).toBe("h399");
  });

  it("doesn't animate a live entry again when it comes back into the window", async () => {
    await open(history(10));
    await pushUser("live");
    const entryOf = (id: string) =>
      [...container.querySelectorAll('[data-testid="chat-user"]')]
        .find((el) => el.textContent === id)
        ?.closest("[data-enter], [class*='entry']");
    expect(entryOf("live")?.hasAttribute("data-enter")).toBe(true);
    // Enough after it that it slides out of the top while at the bottom.
    for (let i = 0; i < WINDOW_ITEMS; i++) await pushUser(`after${i}`);
    expect(mounted()).not.toContain("live");
    // Where follow-bottom (no ResizeObserver in jsdom) would have kept it.
    await scrollTo(Number.MAX_SAFE_INTEGER);
    await scrollTo(scroller().scrollTop - 200);
    await scrollTo(0);
    expect(mounted()).toContain("live");
    expect(entryOf("live")?.hasAttribute("data-enter")).toBe(false);
  });
});
