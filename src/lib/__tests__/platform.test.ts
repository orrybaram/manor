import { describe, it, expect, afterEach } from "vitest";
import { isWebApp } from "../platform";

/**
 * `isWebApp` reads the one field the two bridge implementations disagree on
 * (ADR-178 D8) — nothing about the browser itself, so a stubbed
 * `window.electronAPI.platform` is the whole fixture.
 */
describe("isWebApp", () => {
  const original = window.electronAPI;

  afterEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = original;
  });

  it("is false when the preload bridge is installed", () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: "electron",
    } as never;
    expect(isWebApp()).toBe(false);
  });

  it("is true when the WebSocket bridge is installed", () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: "web",
    } as never;
    expect(isWebApp()).toBe(true);
  });
});
