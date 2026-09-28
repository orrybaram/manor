import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  linkSuggestionToastId,
  offerLinkSuggestions,
  startLinkSuggestions,
  type LinkSuggestion,
} from "../link-suggestions";
import { useHostStore, type HostStatus } from "../host-store";
import { useProjectStore, type ProjectInfo } from "../project-store";
import { useToastStore } from "../toast-store";

// ADR-192 ticket 5: after an add or clone, and once per launch, each project
// on another host with the same `origin` is offered as a toast the user
// accepts or dismisses.

/**
 * A fake main: `local-app` shares an origin with `box-app` and `mac-app`.
 * A dismissed pair stops being suggested, and while the box is away its
 * checkout's origin is unknown, as with `ProjectManager.suggestLinks`.
 */
const dismissed = new Set<string>();
const offline = new Set<string>();
/** The projects main has; `mac-app` only where a test adds it. */
const present = new Set<string>();
const pairKey = (a: string, b: string) => [a, b].sort().join("|");
const HOST: Record<string, string> = { "local-app": "local", "box-app": "box", "mac-app": "mac" };
const SUGGESTIONS: Record<string, LinkSuggestion[]> = {
  "local-app": [
    { projectId: "box-app", name: "box app", hostLabel: "me@box" },
    { projectId: "mac-app", name: "mac app", hostLabel: "me@mac" },
  ],
  "box-app": [{ projectId: "local-app", name: "local app", hostLabel: "this Mac" }],
  "mac-app": [{ projectId: "local-app", name: "local app", hostLabel: "this Mac" }],
};

async function fakeSuggestLinks(projectId: string): Promise<LinkSuggestion[]> {
  return (SUGGESTIONS[projectId] ?? []).filter(
    (s) =>
      present.has(s.projectId) &&
      !dismissed.has(pairKey(projectId, s.projectId)) &&
      !offline.has(HOST[projectId]) &&
      !offline.has(HOST[s.projectId]),
  );
}

const api = {
  getAll: vi.fn(),
  getSelectedIndex: vi.fn(async () => 0),
  suggestLinks: vi.fn(fakeSuggestLinks),
  dismissLinkSuggestion: vi.fn(async (projectId: string, otherId: string) => {
    dismissed.add(pairKey(projectId, otherId));
  }),
  link: vi.fn(async () => {}),
};

// The collapsed set is localStorage-backed; this suite runs without a DOM.
vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: { projects: api },
});

function project(id: string, hostId: string): ProjectInfo {
  return {
    id,
    name: id,
    path: `/code/${id}`,
    hostId,
    defaultBranch: "main",
    workspaces: [{ path: `/code/${id}`, branch: "main", isMain: true, name: null }],
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color: null,
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
    portlessEnabled: true,
    folders: [],
    sidebarOrder: [],
    group: null,
  };
}

/** Set every remote host's status in the host store, as main pushes it. */
function hostsAre(status: HostStatus): void {
  useHostStore.setState({
    hosts: ["box", "mac"].map((hostId) => ({ hostId, spec: null, status })),
  });
}

const toastId = linkSuggestionToastId("local-app", "box-app");
const toast = () => useToastStore.getState().toasts.find((t) => t.id === toastId);
const suggestionToasts = () =>
  useToastStore.getState().toasts.filter((t) => t.id.startsWith("link-suggestion-"));

/** A fresh launch: nothing loaded yet, no toasts. */
function launch(): Promise<void> {
  useProjectStore.setState({ projects: [], initialLoadDone: false });
  useToastStore.setState({ toasts: [] });
  return useProjectStore.getState().loadProjects();
}

describe("link suggestions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    api.suggestLinks.mockImplementation(fakeSuggestLinks);
    dismissed.clear();
    offline.clear();
    present.clear();
    present.add("local-app").add("box-app");
    hostsAre("connected");
    // A fresh session: nothing offered yet.
    await startLinkSuggestions(() => [], vi.fn());
    useToastStore.setState({ toasts: [] });
    api.getAll.mockResolvedValue([project("local-app", "local"), project("box-app", "box")]);
  });

  it("asks before linking, and links on accept", async () => {
    const link = vi.fn(async () => {});

    await offerLinkSuggestions("local-app", link);

    expect(toast()).toMatchObject({ status: "info", message: 'Link with "box app" on me@box?' });
    expect(link).not.toHaveBeenCalled();

    toast()!.action!.onClick();

    expect(link).toHaveBeenCalledWith("local-app", "box-app");
    expect(toast()).toBeUndefined();
    expect(api.dismissLinkSuggestion).not.toHaveBeenCalled();
  });

  it("remembers a dismissal without linking", async () => {
    const link = vi.fn(async () => {});

    await offerLinkSuggestions("local-app", link);
    toast()!.secondaryAction!.onClick();

    expect(api.dismissLinkSuggestion).toHaveBeenCalledWith("local-app", "box-app");
    expect(link).not.toHaveBeenCalled();
    expect(toast()).toBeUndefined();
  });

  it("shows nothing when the lookup fails", async () => {
    api.suggestLinks.mockRejectedValueOnce(new Error("host away"));
    await offerLinkSuggestions("local-app", vi.fn());
    expect(suggestionToasts()).toEqual([]);
  });

  it("offers existing duplicates once per launch, one toast per pair", async () => {
    await launch();
    await vi.waitFor(() => expect(api.suggestLinks).toHaveBeenCalledTimes(2));

    // Both sides suggest the other; the pair gets one toast.
    expect(suggestionToasts()).toHaveLength(1);

    // A later reload in the same session doesn't ask again.
    await useProjectStore.getState().loadProjects();
    expect(api.suggestLinks).toHaveBeenCalledTimes(2);
  });

  it("skips grouped projects at launch", async () => {
    const group = { id: "g1", name: "app", memberIds: ["local-app", "box-app"], lastUsedHostId: null };
    api.getAll.mockResolvedValue([
      { ...project("local-app", "local"), group },
      { ...project("box-app", "box"), group },
    ]);

    await launch();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.suggestLinks).not.toHaveBeenCalled();
  });

  it("doesn't offer a dismissed pair at the next launch", async () => {
    await launch();
    await vi.waitFor(() => expect(suggestionToasts()).toHaveLength(1));
    suggestionToasts()[0].secondaryAction!.onClick();
    await vi.waitFor(() => expect(api.dismissLinkSuggestion).toHaveBeenCalled());

    await launch();
    await vi.waitFor(() => expect(api.suggestLinks).toHaveBeenCalledTimes(4));

    expect(suggestionToasts()).toEqual([]);
  });

  it("offers a pair once its host connects, and only once", async () => {
    hostsAre("disconnected");
    offline.add("box");

    await launch();
    await vi.waitFor(() => expect(api.suggestLinks).toHaveBeenCalledTimes(2));
    expect(suggestionToasts()).toEqual([]);

    offline.clear();
    hostsAre("connected");
    await vi.waitFor(() => expect(suggestionToasts()).toHaveLength(1));
    expect(toast()).toBeDefined();

    // Closed with its X, then the host drops and comes back: not again.
    useToastStore.getState().removeToast(toastId);
    hostsAre("reconnecting");
    hostsAre("connected");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(suggestionToasts()).toEqual([]);
  });

  it("closes other suggestions naming a project once it is linked", async () => {
    present.add("mac-app");
    useProjectStore.setState({ initialLoadDone: true });
    const link = useProjectStore.getState().linkProjects;
    await offerLinkSuggestions("local-app", link);
    expect(suggestionToasts()).toHaveLength(2);

    toast()!.action!.onClick();

    await vi.waitFor(() => expect(api.link).toHaveBeenCalledWith("local-app", "box-app"));
    await vi.waitFor(() => expect(suggestionToasts()).toEqual([]));
  });

  describe("a background pass with many pairs", () => {
    const SUMMARY = "link-suggestions-summary";
    const summary = () => useToastStore.getState().toasts.find((t) => t.id === SUMMARY);

    /**
     * `n` repos cloned on this Mac (`l1`…) and on the box (`b1`…): `n`
     * pairs, each suggested from both sides.
     */
    function duplicates(n: number): void {
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      api.getAll.mockResolvedValue(
        ids.flatMap((i) => [project(`l${i}`, "local"), project(`b${i}`, "box")]),
      );
      api.suggestLinks.mockImplementation(async (projectId: string) => {
        const [side, i] = [projectId[0], projectId.slice(1)];
        const other = side === "l" ? `b${i}` : `l${i}`;
        if (offline.has("box") || dismissed.has(pairKey(projectId, other))) return [];
        return [{ projectId: other, name: other, hostLabel: side === "l" ? "me@box" : "this Mac" }];
      });
    }

    it("shows one summary for 5 pairs at launch, not 5 toasts", async () => {
      duplicates(5);

      await launch();

      await vi.waitFor(() => expect(summary()).toBeDefined());
      expect(summary()).toMatchObject({
        status: "info",
        persistent: true,
        message: "5 projects on other hosts could be linked",
      });
      expect(suggestionToasts()).toEqual([]);
    });

    it("shows 2 pairs at launch as 2 toasts", async () => {
      duplicates(2);

      await launch();

      await vi.waitFor(() => expect(suggestionToasts()).toHaveLength(2));
      expect(summary()).toBeUndefined();
    });

    it("shows one summary when a host connects with 3 pairs", async () => {
      duplicates(3);
      hostsAre("disconnected");
      offline.add("box");
      await launch();
      await vi.waitFor(() => expect(api.suggestLinks).toHaveBeenCalledTimes(6));
      expect(useToastStore.getState().toasts).toEqual([]);

      offline.clear();
      hostsAre("connected");

      await vi.waitFor(() => expect(summary()?.message).toBe("3 projects on other hosts could be linked"));
      expect(suggestionToasts()).toEqual([]);
    });

    it("reviews held pairs one at a time", async () => {
      duplicates(3);
      await launch();
      await vi.waitFor(() => expect(summary()).toBeDefined());

      summary()!.action!.onClick();

      expect(suggestionToasts().map((t) => t.id)).toEqual([linkSuggestionToastId("l1", "b1")]);
      expect(summary()?.message).toBe("2 projects on other hosts could be linked");
    });

    it("dismissing the summary hides it and remembers nothing", async () => {
      duplicates(3);
      await launch();
      await vi.waitFor(() => expect(summary()).toBeDefined());

      summary()!.secondaryAction!.onClick();

      expect(summary()).toBeUndefined();
      expect(suggestionToasts()).toEqual([]);
      expect(api.dismissLinkSuggestion).not.toHaveBeenCalled();
    });
  });
});
