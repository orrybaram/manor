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
      // notification-store.ts subscribes to onChanged/onNavigate and fetches
      // the snapshot at module-init time (ADR-162).
      notifications: {
        getAll: vi.fn().mockResolvedValue([]),
        markRead: vi.fn().mockResolvedValue(undefined),
        markAllRead: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
        onChanged: vi.fn(() => vi.fn()),
        onNavigate: vi.fn(() => vi.fn()),
        show: vi.fn().mockResolvedValue(true),
      },
      // preferences-store.ts and keybindings-store.ts both read their state and
      // subscribe to changes at module-init time, so anything importing them
      // needs these surfaces.
      preferences: {
        getAll: vi.fn().mockResolvedValue({}),
        onChange: vi.fn(() => vi.fn()),
        set: vi.fn(),
      },
      keybindings: {
        getAll: vi.fn().mockResolvedValue({}),
        onChange: vi.fn(() => vi.fn()),
        set: vi.fn(),
        reset: vi.fn(),
        resetAll: vi.fn(),
      },
    },
  };
  (globalThis as unknown as Record<string, unknown>).window = win;
}
