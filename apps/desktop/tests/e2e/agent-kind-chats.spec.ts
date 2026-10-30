import fs from "fs";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import type { DatabaseSync } from "node:sqlite";

import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_KIND } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { localApiHeaders, localApiUrl, type AgentSummary } from "./helpers/local-api";
import { activePaneId, awaitShellReady, paneText, runInTerminal } from "./helpers/terminal";
import { useTheme } from "./helpers/theme";

/**
 * A Codex, a pi and an opencode pane each read as a desk chat: the pane's
 * header flips it to the chat, which renders the session's transcript through
 * that kind's adapter (`electron/chat-mirror/adapters`) and names the agent
 * in its composer. Each is shot in dark and light.
 *
 * No real agent runs. The test puts a transcript where that kind keeps its
 * sessions — the chat-mirror fixtures for Codex and pi, a small v1-schema
 * `opencode.db` built here — and `helpers/fake-agent-kind.sh` posts the
 * hooks that kind's Manor hook would (`kind=<kind>`, `transcriptPath`) from
 * inside the pane, so the pane gets an Agent of that kind.
 */

const FIXTURES = path.join(__dirname, "../../electron/chat-mirror/__fixtures__");

function paneLocator(page: Page, paneId: string) {
  return page.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
}

/** The pane's Agent, once its hooks have made one of `kind`. */
async function paneAgentKind(request: APIRequestContext, tempHome: string, paneId: string): Promise<string | null> {
  const res = await request.get(localApiUrl(tempHome, "/agents"), { headers: localApiHeaders(tempHome) });
  if (!res.ok()) return null;
  const agents = (await res.json()) as AgentSummary[];
  return agents.find((a) => a.paneId === paneId && a.status === "active")?.agentKind ?? null;
}

// ── Transcripts, where each kind keeps them under the temp home ──

const CODEX_SESSION = "019e0000-0000-7000-8000-00000000c0de";

function placeCodexRollout(tempHome: string): string {
  const dir = path.join(tempHome, ".codex", "sessions", "2026", "01", "01");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-01-01T00-00-00-${CODEX_SESSION}.jsonl`);
  fs.copyFileSync(path.join(FIXTURES, "codex", "codex-cli-0.130.0-shell-patch-interrupt.jsonl"), file);
  return file;
}

/** The fixture's own session id (its `session` line). */
const PI_SESSION = "00000000-0000-4000-8000-000000000001";

function placePiSession(tempHome: string): string {
  const dir = path.join(tempHome, ".pi", "agent", "sessions", "--work-repo--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${PI_SESSION}.jsonl`);
  fs.copyFileSync(path.join(FIXTURES, "pi", "session-v3-fix-and-branch.jsonl"), file);
  return file;
}

const OPENCODE_SESSION = "ses_e2eDeskChat01";
const OPENCODE_PROMPT = "Rename slugify to toSlug and run the tests.";
const OPENCODE_INTRO = "Renaming it in src/slug.ts first.";
const OPENCODE_REPLY = "Renamed to toSlug, and the tests pass.";

/**
 * An `opencode.db` in opencode's v1 schema (`message` + `part`, as
 * `electron/chat-mirror/__tests__/opencode-db-source.test.ts` builds it),
 * at the path `opencodeDbPath` resolves for the temp home with no
 * XDG_DATA_HOME or OPENCODE_DB. The chat reads whatever db the locator names,
 * so the spot only matters for the sessions browser. Returns the locator,
 * `<db>#<session>`, or null where this Node has no `node:sqlite`.
 */
function placeOpencodeDb(tempHome: string): string | null {
  const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!sqlite) return null;
  const dir = path.join(tempHome, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT);
    `);
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const message = (id: string, t: number, data: object) =>
      db
        .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
        .run(id, OPENCODE_SESSION, t, t, JSON.stringify(data));
    const part = (id: string, msg: string, t: number, data: object) =>
      db
        .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, msg, OPENCODE_SESSION, t, t, JSON.stringify(data));

    message("msg_0001", t0, { role: "user", time: { created: t0 } });
    part("prt_0001", "msg_0001", t0, { type: "text", text: OPENCODE_PROMPT });

    const t1 = t0 + 2_000;
    message("msg_0002", t1, {
      role: "assistant",
      path: { cwd: "/work/repo" },
      time: { created: t1, completed: t1 + 20_000 },
      finish: "stop",
    });
    part("prt_0002", "msg_0002", t1, { type: "text", text: OPENCODE_INTRO });
    const diff = [
      "Index: /work/repo/src/slug.ts",
      "===================================================================",
      "--- /work/repo/src/slug.ts",
      "+++ /work/repo/src/slug.ts",
      "@@ -1,3 +1,3 @@",
      "-export function slugify(s: string): string {",
      "+export function toSlug(s: string): string {",
      "   return s.toLowerCase().replace(/\\s+/g, \"-\");",
      " }",
      "",
    ].join("\n");
    part("prt_0003", "msg_0002", t1 + 4_000, {
      type: "tool",
      tool: "edit",
      callID: "call_edit_1",
      state: {
        status: "completed",
        input: { filePath: "/work/repo/src/slug.ts" },
        metadata: { diff },
        time: { start: t1 + 4_000, end: t1 + 5_000 },
      },
    });
    part("prt_0004", "msg_0002", t1 + 8_000, {
      type: "tool",
      tool: "bash",
      callID: "call_bash_1",
      state: {
        status: "completed",
        input: { command: "pnpm test" },
        title: "Run the tests",
        output: " ✓ src/slug.test.ts (2 tests)\n",
        time: { start: t1 + 8_000, end: t1 + 14_000 },
      },
    });
    part("prt_0005", "msg_0002", t1 + 16_000, { type: "text", text: OPENCODE_REPLY });
  } finally {
    db.close();
  }
  return `${dbPath}#${OPENCODE_SESSION}`;
}

// ── The cases ──

interface KindCase {
  kind: "codex" | "pi" | "opencode";
  /** What the chat calls the agent (`src/lib/agent-chat.ts`). */
  name: string;
  /** Session id for the hooks, and the transcript (path or locator), or null to skip. */
  place: (tempHome: string) => { sessionId: string; transcript: string } | null;
  user: string;
  assistant: string;
  /** An edit card's file name (`EditCard` shows the base name). */
  editFile: string;
}

const CASES: KindCase[] = [
  {
    kind: "codex",
    name: "Codex",
    place: (home) => ({ sessionId: CODEX_SESSION, transcript: placeCodexRollout(home) }),
    // electron/chat-mirror/__fixtures__/codex/golden/*.json
    user: "Make greet() take a name, and add a test.",
    assistant: "checks it. The test passes.",
    editFile: "greet.ts",
  },
  {
    kind: "pi",
    name: "pi",
    place: (home) => ({ sessionId: PI_SESSION, transcript: placePiSession(home) }),
    // electron/chat-mirror/adapters/__tests__/pi.test.ts
    user: "Actually, open a PR description for the fix instead.",
    assistant: "Let me look at the helper first.",
    editFile: "retry.ts",
  },
  {
    kind: "opencode",
    name: "opencode",
    place: (home) => {
      const transcript = placeOpencodeDb(home);
      return transcript ? { sessionId: OPENCODE_SESSION, transcript } : null;
    },
    user: OPENCODE_PROMPT,
    assistant: OPENCODE_REPLY,
    editFile: "slug.ts",
  },
];

test.describe("agent kind desk chats", () => {
  test.setTimeout(180_000);

  for (const c of CASES) {
    test(`a ${c.name} pane renders its session as a desk chat`, async ({ app, window, tempHome, request }) => {
      // One strip per kind: the file's tests run in parallel, and a Filmstrip clears its directory.
      const film = new Filmstrip(`agent-kind-chats/${c.kind}`);
      const placed = c.place(tempHome);
      test.skip(placed === null, "this Node has no node:sqlite to build an opencode.db with");
      const { sessionId, transcript } = placed!;

      await importSeededProject(app, window, tempHome);
      await createWorkspace(window, `${c.kind}-chat`);
      await openTerminalTab(window);
      const paneId = await activePaneId(window);
      await awaitShellReady(window, tempHome, paneId);
      await runInTerminal(
        window,
        `bash "${FAKE_AGENT_KIND}" ${c.kind} "${sessionId}" "${transcript}" "e2e ${c.kind} chat"`,
      );
      await expect.poll(() => paneText(window, paneId), { timeout: 15_000 }).toContain(`fake ${c.kind} agent ready`);
      await expect
        .poll(() => paneAgentKind(request, tempHome, paneId), { timeout: 20_000, message: `an active ${c.kind} Agent on the pane` })
        .toBe(c.kind);

      const pane = paneLocator(window, paneId);
      const toggle = pane.getByTestId("pane-chat-toggle");
      const chat = pane.getByTestId("chat-pane");
      const terminal = pane.locator('[data-testid="terminal-pane"]');

      // The header offers the chat once the Agent has a transcript; it opens on the desk.
      await expect(toggle).toBeVisible({ timeout: 20_000 });
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await toggle.click();
      await expect(chat).toBeVisible({ timeout: 20_000 });
      await expect(chat).toHaveAttribute("data-layout", "desk");
      await expect(terminal).not.toBeVisible();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");

      // The transcript, through this kind's adapter.
      await expect(chat.getByTestId("chat-unavailable")).toHaveCount(0);
      await expect(chat.getByTestId("chat-user").filter({ hasText: c.user })).toBeVisible({ timeout: 20_000 });
      await expect(chat.getByTestId("chat-assistant").filter({ hasText: c.assistant })).toBeVisible();
      await expect(chat.getByTestId("chat-tool-group").first()).toBeVisible();
      await expect(chat.getByTestId("chat-edit-card").filter({ hasText: c.editFile }).first()).toBeVisible();

      // The composer names the agent; with no / menu, its placeholder offers none.
      const input = chat.getByTestId("chat-composer-input");
      await expect(input).toHaveAttribute("aria-label", `Message ${c.name}`);
      await expect(input).toHaveAttribute("placeholder", `Message ${c.name}`);

      await useTheme(window, "Catppuccin Mocha");
      await film.shot(window, `${c.kind}-dark`);
      await useTheme(window, "Catppuccin Latte");
      await film.shot(window, `${c.kind}-light`);
    });
  }
});
