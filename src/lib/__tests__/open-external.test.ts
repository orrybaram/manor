import { describe, it, expect, afterEach, vi } from "vitest";
import { openExternal } from "../open-external";

/**
 * `shell.openExternal` has no meaning in a browser tab (ADR-178). This is
 * the one call site every fire-and-forget `shell.openExternal(url)` in `src/`
 * was moved onto (ticket 9), so its two branches are the whole contract.
 */
describe("openExternal", () => {
  const originalElectronAPI = window.electronAPI;
  const originalOpen = (window as unknown as { open?: typeof window.open })
    .open;

  afterEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI =
      originalElectronAPI;
    (window as unknown as { open?: typeof window.open }).open = originalOpen;
  });

  it("hands the URL to shell.openExternal on the desktop bridge", () => {
    const openExternalMock = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      platform: "electron",
      shell: { openExternal: openExternalMock },
    } as never;

    openExternal("https://example.com");

    expect(openExternalMock).toHaveBeenCalledWith("https://example.com");
  });

  it("opens a new tab instead on the web bridge", () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      platform: "web",
    } as never;
    const openMock = vi.fn();
    (window as unknown as { open: typeof window.open }).open =
      openMock as never;

    openExternal("https://example.com");

    expect(openMock).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
