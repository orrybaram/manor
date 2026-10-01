/**
 * Vitest setup: a minimal `window` global, in place before any store module
 * is imported, so module-level code in `app-store.ts` — the `layout.changed`
 * subscription among it — finds a host to talk to instead of throwing.
 */
import { vi } from "vitest";
import {
  FAKE_RENDERER_ID,
  fakeLayoutApi,
  fakeViewportApi,
} from "./fake-layout-server";

// Provide a minimal window-like object before any store module is imported.
// Individual test files can override specific properties via vi.stubGlobal.
if (typeof globalThis.window === "undefined") {
  const win: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electronAPI: {
      // ADR-179 D3: the store compares a broadcast's origin with this to
      // decide whether a command's selection hint is its own.
      rendererId: FAKE_RENDERER_ID,
      // No claim: the store under test is a primary window, which shows every
      // tab of the workspace (ADR-179 D4).
      claim: null,
      viewport: fakeViewportApi(),
      // The Manor server's layout store, in-process (ADR-179 D1): `app-store`
      // subscribes to it at import time and every layout action goes through
      // it. See `fake-layout-server.ts`.
      layout: fakeLayoutApi(),
      // agent-store.ts subscribes to agents.onUpdate at module-init time.
      // Provide a minimal agents surface so importing those stores does not
      // throw. Individual tests can override specific methods via
      // vi.stubGlobal.
      agents: {
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
      // stats-store.ts fetches the summary and subscribes to onChanged at
      // module-init time (ADR-168 §5).
      stats: {
        getSummary: vi.fn().mockResolvedValue(null),
        reset: vi.fn().mockResolvedValue(undefined),
        onChanged: vi.fn(() => vi.fn()),
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
      // theme-store.ts subscribes to onChanged at module-init time (ADR-179
      // ticket 7), so anything importing it needs this surface too.
      theme: {
        get: vi.fn().mockResolvedValue(null),
        getSelectedName: vi.fn().mockResolvedValue("__ghostty__"),
        setSelected: vi.fn().mockResolvedValue(null),
        hasGhosttyConfig: vi.fn().mockResolvedValue(false),
        preview: vi.fn().mockResolvedValue(null),
        allColors: vi.fn().mockResolvedValue({}),
        onChanged: vi.fn(() => vi.fn()),
      },
    },
  };
  (globalThis as unknown as Record<string, unknown>).window = win;
}
