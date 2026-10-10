// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail as TaskDetailData, TaskRef, TaskRow } from "../../../lib/tasks";
import { trackerFor } from "../../../lib/trackers";
import { useAppStore } from "../../../store/app-store";
import { useToastStore } from "../../../store/toast-store";
import { makeProject } from "../../../test-utils/fixtures";
import { createTestRoot, type TestRoot } from "../../../test-utils/react-root";
import { TooltipProvider } from "../../ui/Tooltip/Tooltip";
import { TaskDetail } from "./TaskDetail";

const project = makeProject();

const ref: TaskRef = {
  provider: "github",
  project,
  id: "gh-12",
  displayId: "#12",
  title: "Fix the flaky build",
  url: "https://github.com/acme/app/issues/12",
};

const fullDetail: TaskDetailData = {
  body: "The **build** fails on CI.\n\n![shot](https://example.com/a.png)",
  status: { label: "Open", tone: "open" },
  assignees: ["alice"],
  labels: [{ name: "bug", color: "#d73a4a" }],
  milestone: "v1.0",
  images: ["https://example.com/a.png"],
};

const bareDetail: TaskDetailData = {
  body: null,
  status: { label: "Open", tone: "open" },
  assignees: [],
  labels: [],
  images: [],
};

const row = {
  key: "github:p1:12",
  provider: "github",
  displayId: "#12",
  title: ref.title,
  url: ref.url,
  labels: [],
  assignees: [],
  status: { label: "Open", tone: "open" },
  trackerProjects: [],
  createdAt: "",
  updatedAt: "",
  projectEntryKey: "p1",
  project,
  projectName: "Project One",
  color: null,
  raw: { provider: "github", issue: { number: 12 } },
} as unknown as TaskRow;

const noop = () => {};

describe("TaskDetail", () => {
  let root: TestRoot;
  let queryClient: QueryClient;

  function render(
    detail: TaskDetailData,
    props: Partial<ComponentProps<typeof TaskDetail>> = {},
  ) {
    queryClient.setQueryData(trackerFor("github").detailQuery(ref).queryKey, detail);
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          TooltipProvider,
          null,
          createElement(TaskDetail, {
            taskRef: ref,
            mode: "default",
            layout: "card",
            onNewWorkspace: noop,
            onDone: noop,
            ...props,
          }),
        ),
      ),
    );
  }

  function buttons(): string[] {
    return [...root.container.querySelectorAll("button")].map(
      (b) => b.textContent ?? "",
    );
  }

  beforeEach(() => {
    queryClient = new QueryClient();
    useAppStore.setState({ activeWorkspacePath: "/repo/p1" });
    useToastStore.setState({ toasts: [] });
    root = createTestRoot();
  });

  afterEach(() => {
    root.unmount();
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it("renders a task's detail with Start and Open", async () => {
    render(fullDetail, { row });
    await vi.waitFor(() => {
      expect(root.container.querySelector("strong")?.textContent).toBe("build");
      expect(root.container.querySelector("img")).not.toBeNull();
    });
    const text = root.container.textContent ?? "";

    expect(text).toContain("#12");
    expect(text).toContain("Fix the flaky build");
    expect(text).toContain("Open");
    expect(text).toContain("alice");
    expect(text).toContain("bug");
    expect(text).toContain("v1.0");
    expect(text).toContain("Project One");
    // Markdown is rendered, the image in place — the raw URL once the proxy
    // declines (no bridge in tests).
    expect(text).toContain("The build fails on CI.");
    expect(text).not.toContain("![shot]");
    const img = root.container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/a.png");
    expect(img?.getAttribute("alt")).toBe("shot");

    expect(buttons().some((b) => b.startsWith("Start in new workspace"))).toBe(true);
    expect(buttons().some((b) => b.startsWith("New agent here"))).toBe(false);
    const open = root.container.querySelector("a");
    expect(open?.getAttribute("href")).toBe(ref.url);
    expect(open?.textContent).toContain("Open in GitHub");
  });

  it("has no Start without a row", () => {
    render(fullDetail);
    expect(buttons().some((b) => b.startsWith("Start"))).toBe(false);
  });

  it("leaves out fields the task has nothing for", () => {
    render(bareDetail, { layout: "drawer" });
    const text = root.container.textContent ?? "";

    expect(text).toContain("Status");
    expect(text).toContain("Project");
    for (const label of ["Assignee", "Labels", "Priority", "Milestone", "Updated"]) {
      expect(text).not.toContain(label);
    }
    expect(root.container.querySelector("img")).toBeNull();
  });

  it("renders linked mode with Unlink and Close & Unlink, no Start", () => {
    render(fullDetail, {
      row,
      mode: "linked",
      linkedTo: "fix-build",
      projectId: "p1",
      workspacePath: "/repo/p1/wt",
    });
    const text = root.container.textContent ?? "";

    expect(text).toContain("Linked to fix-build");
    expect(buttons()).toEqual(["Unlink", "Close & Unlink"]);
  });

  it("keeps the close when unlinking after it fails", async () => {
    const tracker = trackerFor("github");
    const close = vi.spyOn(tracker, "close").mockResolvedValue();
    vi.spyOn(tracker, "unlink").mockRejectedValue(new Error("nope"));
    const onDone = vi.fn();
    render(fullDetail, {
      mode: "linked",
      linkedTo: "fix-build",
      projectId: "p1",
      workspacePath: "/repo/p1/wt",
      onDone,
    });

    const closeButton = [...root.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Close & Unlink",
    );
    await act(async () => closeButton?.click());

    expect(close).toHaveBeenCalledWith(ref);
    expect(onDone).toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      "Task closed, but failed to unlink",
    ]);
  });
});
