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
      // task-store.ts subscribes to tasks.onUpdate at module-init time, and
      // app-store.closePaneById calls tasks.abandonForPane. Provide a minimal
      // tasks surface so importing those stores does not throw. Individual
      // tests can override specific methods via vi.stubGlobal.
      tasks: {
        onUpdate: vi.fn(() => vi.fn()),
        markSeen: vi.fn().mockResolvedValue(undefined),
        abandonForPane: vi.fn().mockResolvedValue(undefined),
        consumePruneNotice: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        getActive: vi.fn().mockResolvedValue([]),
        getAll: vi.fn().mockResolvedValue([]),
        getUnseen: vi.fn().mockResolvedValue([]),
      },
      // task-store.ts also subscribes to notifications.onNavigateToTask at init.
      notifications: {
        onNavigateToTask: vi.fn(() => vi.fn()),
      },
    },
  };
  (globalThis as unknown as Record<string, unknown>).window = win;
}
