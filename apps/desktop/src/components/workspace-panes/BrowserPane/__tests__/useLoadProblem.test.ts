// @vitest-environment happy-dom
/**
 * The dev-server wait against a fake `<webview>`: its retries, and the
 * events that come in late, after the user has moved on.
 */
import { act, createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot, type TestRoot } from "../../../../test-utils/react-root";
import { useLoadProblem, type ProblemWebview, type UseLoadProblemResult } from "../useLoadProblem";

const PANE = "pane-1";
const DEV = "http://localhost:5173/";

let root: TestRoot;
let webview: ProblemWebview;
let result: UseLoadProblemResult;
let loadUrl: ReturnType<typeof vi.fn>;

function Harness() {
  const loadProblem = useLoadProblem(PANE, { current: webview });
  useLayoutEffect(() => {
    result = loadProblem;
  });
  return null;
}

function fire(type: string, fields: Record<string, unknown>): void {
  act(() => {
    webview.dispatchEvent(Object.assign(new Event(type), fields));
  });
}

const refused = (url = DEV) =>
  fire("did-fail-load", {
    errorCode: -102,
    errorDescription: "ERR_CONNECTION_REFUSED",
    validatedURL: url,
    isMainFrame: true,
  });
const started = (url: string) =>
  fire("did-start-navigation", { url, isInPlace: false, isMainFrame: true });

beforeEach(() => {
  vi.useFakeTimers();
  loadUrl = vi.fn(async () => {});
  (window as unknown as { electronAPI: unknown }).electronAPI = { webview: { loadUrl } };
  webview = Object.assign(document.createElement("div"), { reload: vi.fn() });
  root = createTestRoot();
  root.render(createElement(Harness));
});

afterEach(() => {
  root.unmount();
  vi.useRealTimers();
});

describe("useLoadProblem's dev-server wait", () => {
  it("retries a refused loopback load on a backoff", () => {
    started(DEV);
    refused();
    expect(result.problem).toMatchObject({ kind: "waiting", url: DEV, attempt: 1 });
    act(() => vi.advanceTimersByTime(1_000));
    expect(loadUrl).toHaveBeenCalledWith(PANE, DEV);
    started(DEV);
    expect(result.problem).toMatchObject({ kind: "waiting", attempt: 1 });
    refused();
    expect(result.problem).toMatchObject({ kind: "waiting", attempt: 2 });
  });

  it("stays on the error page when a retry in flight is refused after Cancel", () => {
    started(DEV);
    refused();
    act(() => vi.advanceTimersByTime(1_000)); // the retry goes out
    act(() => result.cancelWait());
    expect(result.problem).toMatchObject({ kind: "failed", url: DEV });
    // The retry's own events land after the Cancel.
    started(DEV);
    expect(result.problem).toMatchObject({ kind: "failed", url: DEV });
    refused();
    expect(result.problem).toMatchObject({ kind: "failed", url: DEV });
    act(() => vi.advanceTimersByTime(10_000));
    expect(loadUrl).toHaveBeenCalledTimes(1);
  });

  it("waits again when the user retries after a Cancel", () => {
    started(DEV);
    refused();
    act(() => result.cancelWait());
    act(() => result.retry());
    expect(loadUrl).toHaveBeenCalledWith(PANE, DEV);
    started(DEV);
    refused();
    expect(result.problem).toMatchObject({ kind: "waiting", attempt: 1 });
  });

  it("waits again when the user goes back to the URL after a Cancel", () => {
    started(DEV);
    refused();
    act(() => result.cancelWait());
    started("https://example.com/");
    expect(result.problem).toBeNull();
    started(DEV);
    refused();
    expect(result.problem).toMatchObject({ kind: "waiting", attempt: 1 });
  });

  it("drops the wait, and its retries, once the user goes elsewhere", () => {
    started(DEV);
    refused();
    started("https://example.com/");
    expect(result.problem).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(loadUrl).not.toHaveBeenCalled();
  });
});
