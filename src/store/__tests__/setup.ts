/**
 * Vitest setup that provides a minimal `window` global so that module-level
 * code in app-store.ts (e.g. `window.addEventListener("beforeunload", ...)`)
 * does not throw a ReferenceError during import.
 */
import { vi } from "vitest";

// Provide a minimal window-like object before any store module is imported.
// Individual test files can override specific properties via vi.stubGlobal.
if (typeof globalThis.window === "undefined") {
  const win: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electronAPI: {
      layout: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn(),
      },
    },
  };
  (globalThis as unknown as Record<string, unknown>).window = win;
}
