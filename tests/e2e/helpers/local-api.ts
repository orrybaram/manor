import fs from "fs";
import path from "path";
import type { APIRequestContext } from "@playwright/test";

import type { TaskSummary } from "../../../electron/routes/tasks";
import type { LayoutSnapshot } from "../../../src/store/layout-snapshot";

/**
 * The app's *local* control surface — `WebviewServer`, the unauthenticated
 * loopback listener the MCP server and CLI already use.
 *
 * Tests reach for it to observe state that the UI renders into a WebGL canvas
 * (terminal output) or not at all (the task list behind a session row). It is
 * also a second, independent witness for anything the phone client claims:
 * when a send lands, this is the path that proves it reached the pty rather
 * than only the view that asked for it.
 *
 * The response types are the app's own, imported rather than re-declared, so a
 * change to either wire shape breaks here instead of being absorbed by a
 * hand-written duplicate.
 */

export type { TaskSummary };

/** The port `WebviewServer` published for this app instance. */
function localApiPort(tempHome: string): number {
  const file = path.join(tempHome, ".manor", "webview-server-port");
  const raw = fs.readFileSync(file, "utf-8").trim();
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Unusable webview-server port: "${raw}"`);
  }
  return port;
}

function localApiUrl(tempHome: string, route: string): string {
  return `http://127.0.0.1:${localApiPort(tempHome)}${route}`;
}

async function getJson<T>(
  request: APIRequestContext,
  tempHome: string,
  route: string,
): Promise<T> {
  const res = await request.get(localApiUrl(tempHome, route));
  if (!res.ok()) throw new Error(`GET ${route} → ${res.status()}`);
  return (await res.json()) as T;
}

function listTasks(
  request: APIRequestContext,
  tempHome: string,
): Promise<TaskSummary[]> {
  return getJson<TaskSummary[]>(request, tempHome, "/tasks");
}

/** The panes the app is actually showing, across the active workspace's tabs. */
async function visiblePaneIds(
  request: APIRequestContext,
  tempHome: string,
): Promise<Set<string>> {
  const layout = await getJson<LayoutSnapshot>(request, tempHome, "/panes");
  return new Set(
    layout.tabs.flatMap((tab) => tab.panes.map((pane) => pane.paneId)),
  );
}

/** Rendered scrollback for a task handle or a raw pane id. */
export async function readSession(
  request: APIRequestContext,
  tempHome: string,
  target: string,
): Promise<string> {
  const res = await request.post(localApiUrl(tempHome, "/sessions/read"), {
    data: { target, tailLines: 200 },
  });
  if (!res.ok()) throw new Error(`POST /sessions/read → ${res.status()}`);
  return ((await res.json()) as { text: string }).text;
}

/**
 * Wait for the session the app is actually showing to park in
 * `requires_input`, and return it.
 *
 * Two things make the naive "first active task" wrong. The signal itself is a
 * whole pipeline — pty env → hook HTTP → relay → `TaskInfo` — so it needs
 * waiting on rather than assuming. And `GET /tasks` legitimately returns more
 * than the sessions on screen: the prewarmed session Manor keeps ready boots
 * the same agent command in the background, and that agent reports its own
 * lifecycle too, so it earns a task row with no project and no pane in the
 * layout. Intersecting with `GET /panes` is what picks out the session a
 * person would point at.
 *
 * `name` is worth waiting for as well: a task is named from its window title,
 * which lands after the row exists, and the phone reads the list once and then
 * only on a status event — so a name that arrives after the client connected
 * never shows up there.
 */
export function waitForVisibleSession(
  request: APIRequestContext,
  tempHome: string,
  { name, timeout = 90_000 }: { name?: string; timeout?: number } = {},
): Promise<TaskSummary> {
  return waitFor(
    name
      ? `an on-screen session named "${name}" in requires_input`
      : "an on-screen session in requires_input",
    async () => {
      const [tasks, panes] = await Promise.all([
        listTasks(request, tempHome),
        visiblePaneIds(request, tempHome),
      ]);
      return (
        tasks.find(
          (task) =>
            task.paneId !== null &&
            panes.has(task.paneId) &&
            task.lastAgentStatus === "requires_input" &&
            (name === undefined || task.name === name),
        ) ?? null
      );
    },
    timeout,
  );
}

/**
 * Poll until `attempt` produces a value.
 *
 * `expect.poll` can only assert on what the callback returns, so waiting for a
 * *value* through it means smuggling the value out in a closure and asserting
 * on a boolean. This keeps the result typed, and treats a throw from `attempt`
 * (the app is still starting, a route is not answering yet) as "not ready".
 */
async function waitFor<T>(
  what: string,
  attempt: () => Promise<T | null>,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  do {
    try {
      const value = await attempt();
      if (value !== null) return value;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);

  const because =
    lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Timed out after ${timeout}ms waiting for ${what}${because}`);
}
