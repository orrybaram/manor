import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "../../ui/Tooltip/Tooltip";
import { makeProject } from "../../../test-utils/fixtures";
import type { TaskRow } from "../../../lib/tasks";
import { TaskTableRow } from "../TaskTableRow";
import type { TaskColumnId } from "../task-columns";

const row = {
  key: "linear:ENG-45",
  provider: "linear",
  displayId: "ENG-45",
  title: "Tighten the Tasks table",
  url: "https://linear.app/acme/issue/ENG-45",
  labels: [],
  assignees: ["Sam"],
  status: { label: "In Progress", tone: "started" },
  priority: { value: 2, label: "High" },
  trackerProjects: [],
  createdAt: "",
  updatedAt: "",
  projectEntryKey: "p1",
  project: makeProject(),
  projectName: "acme",
  color: null,
  raw: { provider: "linear" },
} as unknown as TaskRow;

function render(columns: readonly TaskColumnId[]): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(TaskTableRow, {
        row,
        now: Date.now(),
        columns,
        actionLabel: "Start",
        onAction: () => {},
      }),
    ),
  );
}

describe("TaskTableRow", () => {
  it("shows Priority as its icon alone, named for screen readers", () => {
    const html = render(["priority"]);
    expect(html).toContain('role="img" aria-label="High"');
    expect(html).not.toContain(">High<");
  });

  it("renders a cell for each visible column only", () => {
    expect(render(["id", "status"]).match(/role="cell"/g)).toHaveLength(4);
    expect(render(["status"])).not.toContain("ENG-45<");
  });
});
