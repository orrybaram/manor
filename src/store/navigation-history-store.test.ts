import { describe, it, expect, beforeEach } from "vitest";
import {
  useNavigationHistoryStore,
  locationsEqual,
  type Location,
} from "./navigation-history-store";

const home: Location = { kind: "surface", surface: "home" };

function workspace(
  workspacePath: string,
  panelId = "panel-1",
  tabId = "tab-1",
): Location {
  return { kind: "workspace", workspacePath, panelId, tabId };
}

beforeEach(() => {
  useNavigationHistoryStore.setState({
    entries: [],
    index: -1,
    isNavigating: false,
  });
});

describe("locationsEqual", () => {
  it("treats identical surface locations as equal", () => {
    expect(locationsEqual(home, { kind: "surface", surface: "home" })).toBe(
      true,
    );
  });

  it("treats identical workspace locations as equal", () => {
    expect(
      locationsEqual(workspace("/repo"), workspace("/repo")),
    ).toBe(true);
  });

  it("treats workspace locations with different fields as unequal", () => {
    expect(locationsEqual(workspace("/repo"), workspace("/other"))).toBe(
      false,
    );
    expect(
      locationsEqual(workspace("/repo", "panel-1"), workspace("/repo", "panel-2")),
    ).toBe(false);
    expect(
      locationsEqual(
        workspace("/repo", "panel-1", "tab-1"),
        workspace("/repo", "panel-1", "tab-2"),
      ),
    ).toBe(false);
  });

  it("treats different kinds as unequal", () => {
    expect(locationsEqual(home, workspace("/repo"))).toBe(false);
  });
});

describe("navigation-history-store", () => {
  it("records entries and advances the index", () => {
    useNavigationHistoryStore.getState().record(home);
    useNavigationHistoryStore.getState().record(workspace("/repo"));

    const state = useNavigationHistoryStore.getState();
    expect(state.entries).toEqual([home, workspace("/repo")]);
    expect(state.index).toBe(1);
  });

  it("dedupes consecutive identical locations", () => {
    useNavigationHistoryStore.getState().record(home);
    useNavigationHistoryStore.getState().record(home);
    useNavigationHistoryStore.getState().record(home);

    const state = useNavigationHistoryStore.getState();
    expect(state.entries).toEqual([home]);
    expect(state.index).toBe(0);
  });

  it("truncates forward entries when recording after going back", () => {
    const { record, goBack } = useNavigationHistoryStore.getState();
    record(home);
    record(workspace("/repo-a"));
    record(workspace("/repo-b"));

    goBack(); // now at workspace("/repo-a")
    useNavigationHistoryStore.getState().record(workspace("/repo-c"));

    const state = useNavigationHistoryStore.getState();
    expect(state.entries).toEqual([
      home,
      workspace("/repo-a"),
      workspace("/repo-c"),
    ]);
    expect(state.index).toBe(2);
  });

  it("goBack returns null at the start of history", () => {
    useNavigationHistoryStore.getState().record(home);
    expect(useNavigationHistoryStore.getState().goBack()).toBeNull();
    expect(useNavigationHistoryStore.getState().index).toBe(0);
  });

  it("goBack and goForward move the index and return the current entry", () => {
    const { record } = useNavigationHistoryStore.getState();
    record(home);
    record(workspace("/repo-a"));
    record(workspace("/repo-b"));

    expect(useNavigationHistoryStore.getState().goBack()).toEqual(
      workspace("/repo-a"),
    );
    expect(useNavigationHistoryStore.getState().goBack()).toEqual(home);
    expect(useNavigationHistoryStore.getState().goBack()).toBeNull();

    expect(useNavigationHistoryStore.getState().goForward()).toEqual(
      workspace("/repo-a"),
    );
    expect(useNavigationHistoryStore.getState().goForward()).toEqual(
      workspace("/repo-b"),
    );
    expect(useNavigationHistoryStore.getState().goForward()).toBeNull();
  });

  it("canGoBack / canGoForward reflect the current position", () => {
    const { record, goBack } = useNavigationHistoryStore.getState();
    expect(useNavigationHistoryStore.getState().canGoBack()).toBe(false);
    expect(useNavigationHistoryStore.getState().canGoForward()).toBe(false);

    record(home);
    record(workspace("/repo-a"));
    expect(useNavigationHistoryStore.getState().canGoBack()).toBe(true);
    expect(useNavigationHistoryStore.getState().canGoForward()).toBe(false);

    goBack();
    expect(useNavigationHistoryStore.getState().canGoBack()).toBe(false);
    expect(useNavigationHistoryStore.getState().canGoForward()).toBe(true);
  });

  it("reset clears entries and index", () => {
    const { record, reset } = useNavigationHistoryStore.getState();
    record(home);
    record(workspace("/repo"));

    reset();

    const state = useNavigationHistoryStore.getState();
    expect(state.entries).toEqual([]);
    expect(state.index).toBe(-1);
  });

  it("setNavigating toggles isNavigating without touching entries", () => {
    useNavigationHistoryStore.getState().record(home);
    useNavigationHistoryStore.getState().setNavigating(true);
    expect(useNavigationHistoryStore.getState().isNavigating).toBe(true);
    expect(useNavigationHistoryStore.getState().entries).toEqual([home]);

    useNavigationHistoryStore.getState().setNavigating(false);
    expect(useNavigationHistoryStore.getState().isNavigating).toBe(false);
  });
});
