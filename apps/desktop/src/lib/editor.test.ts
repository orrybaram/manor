import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store/app-store";
import { usePreferencesStore } from "../store/preferences-store";
import { editorIsManor, editorName, openInEditor } from "./editor";

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

describe("Manor as the editor", () => {
  const setEditor = (defaultEditor: string) =>
    usePreferencesStore.setState((s) => ({
      preferences: { ...s.preferences, defaultEditor },
    }));

  it("is Manor while no editor command is set", () => {
    setEditor("");
    expect(editorIsManor()).toBe(true);
    expect(editorName("")).toBe("Manor");
    setEditor("  ");
    expect(editorIsManor()).toBe(true);
  });

  it("is the command once one is set", () => {
    setEditor("code");
    expect(editorIsManor()).toBe(false);
    expect(editorName("code")).toBe("code");
  });
});
