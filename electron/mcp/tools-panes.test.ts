import { describe, it, expect, afterEach } from "vitest";
import { formatLayoutSnapshot, panesModule } from "./tools-panes";
import type { LayoutSnapshot } from "../../src/store/layout-snapshot";
import type { Http } from "./types";
import { HttpError } from "./types";

describe("formatLayoutSnapshot", () => {
  it("reports no tabs for an empty workspace", () => {
    const snapshot: LayoutSnapshot = {
      workspacePath: "/ws",
      activeTabId: null,
      focusedPaneId: null,
      tabs: [],
    };
    expect(formatLayoutSnapshot(snapshot)).toBe("/ws\n  (no tabs)");
  });

  // The bug this ADR fixes: three tabs in one panel printed `[focused]` thrice.
  it("prints exactly one [active] and one [focused] across three tabs", () => {
    const snapshot: LayoutSnapshot = {
      workspacePath: "/ws",
      activeTabId: "t2",
      focusedPaneId: "p2",
      tabs: [
        {
          tabId: "t1",
          title: "One",
          focusedPaneId: "p1",
          panes: [{ paneId: "p1", contentType: "terminal" }],
        },
        {
          tabId: "t2",
          title: "Two",
          focusedPaneId: "p2",
          panes: [{ paneId: "p2", contentType: "terminal" }],
        },
        {
          tabId: "t3",
          title: "Three",
          focusedPaneId: "p3",
          panes: [{ paneId: "p3", contentType: "terminal" }],
        },
      ],
    };

    const output = formatLayoutSnapshot(snapshot);
    expect(output.match(/\[active\]/g)).toHaveLength(1);
    expect(output.match(/\[focused\]/g)).toHaveLength(1);
    expect(output).toContain("  Two (tabId: t2) [active]");
    expect(output).toContain("    - terminal (paneId: p2) [focused]");
    expect(output).toContain("  One (tabId: t1)\n");
  });

  it("appends the url for browser panes", () => {
    const snapshot: LayoutSnapshot = {
      workspacePath: "/ws",
      activeTabId: "t1",
      focusedPaneId: "p1",
      tabs: [
        {
          tabId: "t1",
          title: "One",
          focusedPaneId: "p1",
          panes: [
            {
              paneId: "p1",
              contentType: "browser",
              url: "https://example.com",
            },
          ],
        },
      ],
    };

    expect(formatLayoutSnapshot(snapshot)).toBe(
      "/ws\n  One (tabId: t1) [active]\n" +
        "    - browser (paneId: p1) https://example.com [focused]",
    );
  });
});

// ── Caller-context defaulting (ADR-152 ticket 10) ──

/** A ~6-line fake `Http` that records every call and returns canned responses. */
function fakeHttp(overrides: Partial<Http> = {}): Http & {
  calls: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }>;
} {
  const calls: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }> = [];
  return {
    calls,
    get: async (path) => {
      calls.push({ method: "GET", path });
      if (overrides.get) return overrides.get(path);
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path, body) => {
      calls.push({ method: "POST", path, body });
      if (overrides.post) return overrides.post(path, body);
      return { paneId: "new-pane", tabId: "new-tab" };
    },
    del: async (path, body) => {
      calls.push({ method: "DEL", path, body });
      if (overrides.del) return overrides.del(path, body);
      return {};
    },
  };
}

describe("split_pane caller-pane defaulting", () => {
  const original = process.env.MANOR_PANE_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.MANOR_PANE_ID;
    else process.env.MANOR_PANE_ID = original;
  });

  it("defaults paneId to MANOR_PANE_ID when args omit it", async () => {
    process.env.MANOR_PANE_ID = "pane-7";
    const http = fakeHttp();
    await panesModule.handlers.split_pane({ direction: "horizontal" }, http);
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/panes/split",
      body: { direction: "horizontal", paneId: "pane-7" },
    });
  });

  it("sends no paneId when MANOR_PANE_ID is unset", async () => {
    delete process.env.MANOR_PANE_ID;
    const http = fakeHttp();
    await panesModule.handlers.split_pane({ direction: "vertical" }, http);
    expect(http.calls[0].body).toEqual({ direction: "vertical" });
    expect(http.calls[0].body).not.toHaveProperty("paneId");
  });

  it("an explicit args.paneId always wins over MANOR_PANE_ID", async () => {
    process.env.MANOR_PANE_ID = "pane-7";
    const http = fakeHttp();
    await panesModule.handlers.split_pane(
      { direction: "horizontal", paneId: "explicit-pane" },
      http,
    );
    expect(http.calls[0].body).toMatchObject({ paneId: "explicit-pane" });
  });
});

describe("new_terminal / new_browser caller-workspace defaulting", () => {
  it("new_terminal resolves the caller's workspace via GET /context when omitted", async () => {
    const http = fakeHttp({
      get: async () => ({ workspacePath: "/resolved/ws" }),
    });
    await panesModule.handlers.new_terminal({}, http);
    expect(http.calls[0]).toMatchObject({ method: "GET" });
    expect(http.calls[0].path).toMatch(/^\/context/);
    expect(http.calls[1]).toMatchObject({
      method: "POST",
      path: "/tabs",
      body: { contentType: "terminal", workspacePath: "/resolved/ws" },
    });
  });

  it("new_terminal: an explicit args.workspacePath wins and /context is not called", async () => {
    const http = fakeHttp();
    await panesModule.handlers.new_terminal(
      { workspacePath: "/explicit/ws" },
      http,
    );
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/tabs",
      body: { contentType: "terminal", workspacePath: "/explicit/ws" },
    });
  });

  it("new_browser resolves the caller's workspace via GET /context when omitted", async () => {
    const http = fakeHttp({
      get: async () => ({ workspacePath: "/resolved/ws" }),
    });
    await panesModule.handlers.new_browser(
      { url: "https://example.com" },
      http,
    );
    expect(http.calls[0]).toMatchObject({ method: "GET" });
    expect(http.calls[1]).toMatchObject({
      method: "POST",
      path: "/tabs",
      body: {
        contentType: "browser",
        url: "https://example.com",
        workspacePath: "/resolved/ws",
      },
    });
  });

  it("new_browser: an explicit args.workspacePath wins and /context is not called", async () => {
    const http = fakeHttp();
    await panesModule.handlers.new_browser(
      { url: "https://example.com", workspacePath: "/explicit/ws" },
      http,
    );
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      body: { workspacePath: "/explicit/ws" },
    });
  });

  it("propagates resolveContext's friendly error instead of falling back to the user's active workspace", async () => {
    const http = fakeHttp({
      get: async () => {
        throw new HttpError(
          404,
          { error: "No project found for cwd", candidates: [] },
          "not found",
        );
      },
    });
    await expect(panesModule.handlers.new_terminal({}, http)).rejects.toThrow(
      /No project found for cwd/,
    );
    // The tool call fails outright rather than silently posting to /tabs
    // against the user's active workspace.
    expect(http.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

// ── ADR-171 ticket 3: tab and pane control surface ──

describe("pin_tab", () => {
  it("POSTs to the tab's pin endpoint and reports the returned state", async () => {
    const http = fakeHttp({
      post: async () => ({ tabId: "tab-1", pinned: true }),
    });

    const result = await panesModule.handlers.pin_tab({ tabId: "tab-1" }, http);

    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/tabs/tab-1/pin",
    });
    expect(result.content[0].text).toMatch(/tab-1 is now pinned/);
  });

  it("encodes the tabId into the path", async () => {
    const http = fakeHttp({
      post: async () => ({ tabId: "a/b", pinned: false }),
    });

    await panesModule.handlers.pin_tab({ tabId: "a/b" }, http);

    expect(http.calls[0].path).toBe("/tabs/a%2Fb/pin");
  });
});

describe("move_pane", () => {
  it("sends targetPaneId and direction, omitting position when unset", async () => {
    const http = fakeHttp();

    await panesModule.handlers.move_pane(
      { paneId: "pane-1", targetPaneId: "pane-2", direction: "horizontal" },
      http,
    );

    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/panes/pane-1/move",
      body: { targetPaneId: "pane-2", direction: "horizontal" },
    });
    expect(http.calls[0].body).not.toHaveProperty("position");
  });

  it("includes position when the caller supplies it", async () => {
    const http = fakeHttp();

    await panesModule.handlers.move_pane(
      {
        paneId: "pane-1",
        targetPaneId: "pane-2",
        direction: "vertical",
        position: "first",
      },
      http,
    );

    expect(http.calls[0].body).toMatchObject({ position: "first" });
  });
});

describe("set_active_workspace caller-workspace defaulting", () => {
  it("resolves the caller's workspace via GET /context when omitted", async () => {
    const http = fakeHttp({
      get: async () => ({ workspacePath: "/resolved/ws" }),
    });

    await panesModule.handlers.set_active_workspace({}, http);

    expect(http.calls[0]).toMatchObject({ method: "GET" });
    expect(http.calls[1]).toMatchObject({
      method: "POST",
      path: "/workspaces/active",
      body: { workspacePath: "/resolved/ws" },
    });
  });

  it("an explicit args.workspacePath wins and /context is not called", async () => {
    const http = fakeHttp();

    await panesModule.handlers.set_active_workspace(
      { workspacePath: "/explicit/ws" },
      http,
    );

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/workspaces/active",
      body: { workspacePath: "/explicit/ws" },
    });
  });
});
