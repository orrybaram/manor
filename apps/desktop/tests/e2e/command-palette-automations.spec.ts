import path from "path";

import type { APIRequestContext, Page } from "@playwright/test";

import { expect, importSeededProject, test } from "./fixtures";
import { Filmstrip } from "./helpers/filmstrip";
import { FAKE_AGENT } from "./helpers/fake-agent";
import { localApiHeaders, localApiUrl } from "./helpers/local-api";

/**
 * The palette's Automations group: each automation opens its page in
 * Settings → Automations or runs now, and New Automation opens a new one.
 * Seeded through the local HTTP API, as `automations-settings.spec.ts` does.
 */

async function api<T>(
  request: APIRequestContext,
  tempHome: string,
  method: "GET" | "POST",
  route: string,
  data?: Record<string, unknown>,
): Promise<T> {
  const res = await request.fetch(localApiUrl(tempHome, route), {
    method,
    headers: localApiHeaders(tempHome),
    data: data ?? (method === "GET" ? undefined : {}),
    timeout: 60_000,
  });
  if (!res.ok())
    throw new Error(`${method} ${route} → ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

const paletteInput = (window: Page) => window.locator("[cmdk-input]");
const item = (window: Page, label: string) =>
  window.locator("[cmdk-item]", { hasText: label }).first();

async function search(window: Page, text: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(paletteInput(window)).toBeVisible();
  await paletteInput(window).fill(text);
}

test("the palette opens, runs and creates automations", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  test.setTimeout(180_000);
  const film = new Filmstrip("command-palette-automations");

  await importSeededProject(app, window, tempHome);
  const wizard = window.getByTestId("project-setup-wizard");
  if (await wizard.isVisible().catch(() => false))
    await window.keyboard.press("Escape");

  const projects = await api<{ id: string; path: string }[]>(
    request,
    tempHome,
    "GET",
    "/projects",
  );
  const project =
    projects.find((p) => p.path === path.join(tempHome, "test-project")) ??
    projects[0];
  if (!project) throw new Error("GET /projects listed no seeded project");
  await api(request, tempHome, "POST", `/projects/${project.id}/update`, {
    agentCommand: `"${FAKE_AGENT}"`,
  });
  const triage = await api<{ id: string }>(
    request,
    tempHome,
    "POST",
    "/automations",
    {
      name: "Morning PR triage",
      agentKind: "claude",
      projectId: project.id,
      schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
      prompt: "Triage the open pull requests.",
      workspace: { mode: "new" },
      enabled: true,
    },
  );

  // Listed by name, with a Run Now row beside it.
  await search(window, "triage");
  await expect(item(window, "Morning PR triage")).toBeVisible({
    timeout: 15_000,
  });
  await expect(item(window, "Run Now: Morning PR triage")).toBeVisible();
  await film.shot(window, "palette-automation-search");

  // Its row opens its page in Settings.
  await item(window, "Morning PR triage").click();
  await expect(paletteInput(window)).not.toBeVisible();
  await expect(window.getByTestId("automation-detail")).toBeVisible({
    timeout: 15_000,
  });
  await expect(window.getByTestId("automation-name")).toHaveValue(
    "Morning PR triage",
  );
  await film.shot(window, "settings-automation-page");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("automation-detail")).not.toBeVisible();

  // Run Now starts a run without leaving for Settings.
  await search(window, "run now triage");
  await item(window, "Run Now: Morning PR triage").click();
  await expect(window.getByText("Started Morning PR triage")).toBeVisible({
    timeout: 15_000,
  });
  await film.shot(window, "run-now-toast");
  await expect
    .poll(
      async () =>
        (
          await api<{ runs: unknown[] }>(
            request,
            tempHome,
            "GET",
            `/automations/${triage.id}`,
          )
        ).runs.length,
      { timeout: 30_000 },
    )
    .toBe(1);

  // New Automation opens an empty one.
  await search(window, "new automation");
  await item(window, "New Automation").click();
  await expect(window.getByTestId("automation-create")).toBeVisible({
    timeout: 15_000,
  });
  await film.shot(window, "settings-new-automation");
});
