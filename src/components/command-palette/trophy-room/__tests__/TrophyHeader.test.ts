// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsSummary } from "../../../../electron.d";
import { STARTER_TITLES } from "../../../../lib/badges";
import { usePreferencesStore } from "../../../../store/preferences-store";
import {
  createTestRoot,
  type TestRoot,
} from "../../../../test-utils/react-root";
import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";

// The login shells out to `gh` over IPC; the header only shows it.
const login = { value: null as string | null };
vi.mock("../useGitHubLogin", () => ({ useGitHubLogin: () => login.value }));

const { TrophyHeader } = await import("../TrophyHeader");

function summary(badges: Record<string, string> = {}): StatsSummary {
  return {
    today: {},
    last7Days: {},
    allTime: {},
    streakWeeks: 0,
    dailyPrompts: [],
    dailyPrsMerged: [],
    badges,
    enabled: true,
  };
}

const AT = "2026-01-01T00:00:00.000Z";
const TENURE_COMPLETE = {
  "week-streak": AT,
  "month-streak": AT,
  regular: AT,
  devoted: AT,
  "half-year": AT,
  "year-round": AT,
};

/** Mounted in an open dialog, as the palette mounts it. */
function header(s: StatsSummary, onOpenChange = vi.fn()) {
  return createElement(
    TooltipProvider,
    null,
    createElement(
      Dialog.Root,
      { open: true, onOpenChange },
      createElement(
        Dialog.Portal,
        null,
        createElement(
          Dialog.Content,
          { "aria-describedby": undefined },
          createElement(Dialog.Title, null, "Palette"),
          createElement(TrophyHeader, { summary: s }),
        ),
      ),
    ),
  );
}

function pencil(): HTMLElement {
  return document.querySelector<HTMLElement>('[aria-label="Change title"]')!;
}

function menuItems(): string[] {
  return Array.from(document.querySelectorAll("[data-menu-item]")).map(
    (el) => el.textContent ?? "",
  );
}

let root: TestRoot;

beforeEach(() => {
  login.value = null;
  usePreferencesStore.setState((s) => ({
    preferences: { ...s.preferences, achievementTitle: null },
  }));
  root = createTestRoot();
  document.body.appendChild(root.container);
});

afterEach(() => {
  root.unmount();
  root.container.remove();
});

describe("TrophyHeader", () => {
  it("leads with the GitHub login, the title small under it", () => {
    login.value = "octocat";
    root.render(header(summary()));
    const block = pencil().closest("header")!.firstElementChild!;
    expect(block.children[0].textContent).toBe("@octocat");
    expect(block.children[1].textContent).toBe(STARTER_TITLES[0]);
    expect(block.textContent).not.toContain("Title");
  });

  it("leads with the title when there is no login", () => {
    root.render(header(summary()));
    const block = pencil().closest("header")!.firstElementChild!;
    expect(block.children).toHaveLength(1);
    expect(block.textContent).toBe(STARTER_TITLES[0]);
  });

  it("opens the title menu, earned first, and picks a title", () => {
    root.render(header(summary(TENURE_COMPLETE)));
    expect(menuItems()).toEqual([]);

    act(() => pencil().click());
    expect(menuItems()).toEqual(["Old Guard", ...STARTER_TITLES]);

    const tinkerer = Array.from(
      document.querySelectorAll<HTMLElement>("[data-menu-item]"),
    ).find((el) => el.textContent === "Tinkerer")!;
    act(() => tinkerer.click());
    expect(usePreferencesStore.getState().preferences.achievementTitle).toBe(
      "Tinkerer",
    );
    expect(menuItems()).toEqual([]);
  });

  it("closes the menu on Escape without closing the dialog", () => {
    const onOpenChange = vi.fn();
    root.render(header(summary(), onOpenChange));
    act(() => pencil().click());
    expect(menuItems()).toHaveLength(STARTER_TITLES.length);

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(menuItems()).toEqual([]);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

/** The `z-index` declared in the first `selector { … }` block of a CSS file. */
function zIndexOf(cssPath: string, selector: string): number {
  const css = readFileSync(new URL(cssPath, import.meta.url), "utf8");
  const block = css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
  return Number(/z-index:\s*(\d+)/.exec(block)?.[1]);
}

describe("title menu stacking", () => {
  // The menu is portalled to <body>, beside the palette rather than inside
  // it. Stacked at or below the palette it opens out of sight behind it,
  // which read as the pencil doing nothing.
  it("stacks above the palette", () => {
    const menu = zIndexOf("../TrophyRoom.module.css", ".titleMenu");
    const palette = zIndexOf("../../CommandPalette.module.css", ".palette");
    expect(palette).toBeGreaterThan(0);
    expect(menu).toBeGreaterThan(palette);
  });
});
