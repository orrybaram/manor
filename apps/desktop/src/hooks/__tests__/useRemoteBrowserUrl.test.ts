// @vitest-environment happy-dom
/**
 * The webview's `src` is the first URL the pane loads and never changes:
 * React rewriting the attribute makes Electron load it, so a `src` that
 * followed the page would turn each client-side route change into a reload.
 */
import { act, createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../useHostDisplay", () => ({ useHostDisplay: () => ({ target: "box" }) }));
vi.mock("../../lib/port-forward-open", () => ({
  forwardedUrl: vi.fn(async () => "http://127.0.0.1:49152/"),
}));

import { createTestRoot, type TestRoot } from "../../test-utils/react-root";
import { useRemoteBrowserUrl, type UseRemoteBrowserUrlResult } from "../useRemoteBrowserUrl";

let root: TestRoot;
let result: UseRemoteBrowserUrlResult;
const webview = { src: "" };

function Harness(props: { initialUrl: string; remoteHostId: string | null }) {
  const remote = useRemoteBrowserUrl({
    paneId: "pane-1",
    remoteHostId: props.remoteHostId,
    initialUrl: props.initialUrl,
    webviewRef: { current: webview },
  });
  useLayoutEffect(() => {
    result = remote;
  });
  return null;
}

const render = (initialUrl: string, remoteHostId: string | null = null) =>
  root.render(createElement(Harness, { initialUrl, remoteHostId }));

/** A main-frame `did-navigate` to `url`. */
const navigated = (url: string) =>
  Object.assign(new Event("did-navigate"), { url, isMainFrame: true });

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ports: { remoteUrl: vi.fn(async (url: string) => url.replace("127.0.0.1:49152", "localhost:3000")) },
  };
  root = createTestRoot();
});

afterEach(() => {
  root.unmount();
});

describe("useRemoteBrowserUrl's src", () => {
  it("keeps a local pane's first URL when the URL it is given changes", () => {
    render("http://localhost:3000/");
    expect(result.src).toBe("http://localhost:3000/");
    render("http://localhost:3000/settings");
    render("https://example.com/");
    expect(result.src).toBe("http://localhost:3000/");
  });

  it("keeps a remote pane's first URL when the URL it is given changes", () => {
    render("https://example.com/", "box");
    expect(result.src).toBe("https://example.com/");
    render("https://example.com/next", "box");
    expect(result.src).toBe("https://example.com/");
  });

  it("keeps a remote pane on its blank placeholder while its box URL resolves, and after", async () => {
    render("http://localhost:3000/", "box");
    expect(result.src).toBe("about:blank");
    await act(async () => result.resolveInitialLoad());
    render("http://localhost:3000/settings", "box");
    expect(result.src).toBe("about:blank");
  });

  it("never follows a navigation, local or remote", async () => {
    const apply = vi.fn();
    render("http://localhost:3000/");
    act(() => result.onNavigate(navigated("http://localhost:3000/a"), apply));
    render("http://localhost:3000/a");
    expect(apply).toHaveBeenCalledWith("http://localhost:3000/a", "http://localhost:3000/a");
    expect(result.src).toBe("http://localhost:3000/");

    root.unmount();
    root = createTestRoot();
    render("https://example.com/", "box");
    await act(async () => result.onNavigate(navigated("http://127.0.0.1:49152/b"), apply));
    render("http://localhost:3000/b", "box");
    expect(apply).toHaveBeenLastCalledWith("http://localhost:3000/b", "http://127.0.0.1:49152/b");
    expect(result.src).toBe("https://example.com/");
  });
});
