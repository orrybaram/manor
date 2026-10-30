import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/app-store";
import { usePreferencesStore } from "../store/preferences-store";
import { openInEditor } from "./editor";

describe("openInEditor with a terminal editor", () => {
  const addTerminalTab = vi.fn();

  beforeEach(() => {
    addTerminalTab.mockReset();
    useAppStore.setState({ addTerminalTab } as never);
    usePreferencesStore.setState((s) => ({
      preferences: { ...s.preferences, defaultEditor: "nvim", editorIsTerminal: true },
    }));
  });

  it("quotes a file name a repo chose, so the shell runs nothing in it", () => {
    openInEditor("/repo/notes$(touch PWNED).md");
    expect(addTerminalTab).toHaveBeenCalledWith("nvim '/repo/notes$(touch PWNED).md'");
  });

  it("types nothing for a name with control characters", () => {
    openInEditor("/repo/a\u0003b.md");
    expect(addTerminalTab).not.toHaveBeenCalled();
  });
});
