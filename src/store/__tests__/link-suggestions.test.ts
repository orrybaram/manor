import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  linkSuggestionToastId,
  offerLinkSuggestions,
  type LinkSuggestion,
} from "../link-suggestions";
import { useToastStore } from "../toast-store";

// ADR-192 ticket 5: after an add or clone, each project on another host with
// the same `origin` is offered as a toast the user accepts or dismisses.

const api = {
  suggestLinks: vi.fn(),
  dismissLinkSuggestion: vi.fn(async () => {}),
};

vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: { projects: api },
});

const BOX_APP: LinkSuggestion = {
  projectId: "box-app",
  name: "app",
  hostId: "box",
  hostLabel: "me@box",
  groupId: null,
};

const toastId = linkSuggestionToastId("local-app", "box-app");
const toast = () => useToastStore.getState().toasts.find((t) => t.id === toastId);

describe("offerLinkSuggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
  });

  it("asks before linking, and links on accept", async () => {
    api.suggestLinks.mockResolvedValue([BOX_APP]);
    const link = vi.fn(async () => {});

    await offerLinkSuggestions("local-app", link);

    expect(api.suggestLinks).toHaveBeenCalledWith("local-app");
    expect(toast()?.message).toBe('Link with "app" on me@box?');
    expect(link).not.toHaveBeenCalled();

    toast()!.action!.onClick();

    expect(link).toHaveBeenCalledWith("local-app", "box-app");
    expect(toast()).toBeUndefined();
    expect(api.dismissLinkSuggestion).not.toHaveBeenCalled();
  });

  it("remembers a dismissal without linking", async () => {
    api.suggestLinks.mockResolvedValue([BOX_APP]);
    const link = vi.fn(async () => {});

    await offerLinkSuggestions("local-app", link);
    toast()!.secondaryAction!.onClick();

    expect(api.dismissLinkSuggestion).toHaveBeenCalledWith("local-app", "box-app");
    expect(link).not.toHaveBeenCalled();
    expect(toast()).toBeUndefined();
  });

  it("shows nothing when there is no match or the lookup fails", async () => {
    api.suggestLinks.mockResolvedValue([]);
    await offerLinkSuggestions("local-app", vi.fn());
    expect(useToastStore.getState().toasts).toEqual([]);

    api.suggestLinks.mockRejectedValue(new Error("host away"));
    await offerLinkSuggestions("local-app", vi.fn());
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
