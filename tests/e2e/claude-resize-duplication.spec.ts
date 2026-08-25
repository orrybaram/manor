import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { flatten } from "./helpers/ansi";
import { dragWindowSize } from "./helpers/window";
import {
  activePaneId,
  awaitShellReady,
  paneOverflowPx,
  runInTerminal,
  scrollback,
} from "./helpers/terminal";
import {
  DUPLICATE_CEILING,
  FIRST_MARKER,
  LAST_MARKER,
  MARKERS,
  PROMPT,
  duplicates,
  printed,
} from "./helpers/zq-run";

/**
 * The bug, driven by the program that actually shows it.
 *
 * `fake-tui.sh` repaints in full — it erases with `ESC[0J` and redraws — so it
 * cannot strand anything the way Claude Code does. Claude Code repaints
 * *differentially* while it streams and then repaints its whole screen from
 * `ESC[H` on `SIGWINCH`, erasing exactly as many rows as `process.stdout` says
 * it has. Any moment the grid disagrees with that number leaves the top of the
 * old frame behind, and once that row scrolls off no cursor-up can reach it
 * again (ADR-165).
 *
 * So this runs the real thing: `claude`, told to emit 200 numbered lines, with
 * the window dragged after they land. Each marker was printed once, so each
 * must be on screen once — up to a floor that is the terminal's rather than
 * manor's; see `helpers/zq-run`.
 *
 * Requires a logged-in Claude Code on the machine, and is skipped without one.
 */

const CLAUDE_BIN = path.join(process.env.HOME ?? "", ".local/bin/claude");
const HAVE_CLAUDE = fs.existsSync(CLAUDE_BIN);

/**
 * A Claude that would otherwise be inherited.
 *
 * A run started from inside Claude Code picks up its session markers and
 * settings, which changes how the child renders — and the rendering is the
 * thing under test.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE_CODE") || key.startsWith("ANTHROPIC_")) {
    delete process.env[key];
  }
}

/** Two grid moves closer together than this are one size and its correction. */
const PHANTOM_WINDOW_MS = 250;

function seedClaudeConfig(tempHome: string): void {
  // Claude Code decides it is logged out from `oauthAccount`/`userID` in the
  // config, not from the keychain entry alone, so the real config is the
  // starting point. Everything about *this machine's* work is dropped: no
  // projects (so nothing is pre-trusted or pre-onboarded from elsewhere) and
  // no MCP servers (the launched app must not talk to the running one).
  const real = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME ?? "", ".claude.json"), "utf8"),
  ) as Record<string, unknown>;
  fs.writeFileSync(
    path.join(tempHome, ".claude.json"),
    JSON.stringify({ ...real, projects: {}, mcpServers: {} }, null, 2),
  );
  fs.mkdirSync(path.join(tempHome, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(tempHome, ".claude/settings.json"), "{}");

  // The OAuth token lives in the login keychain on macOS, and Claude Code does
  // not find it from a different HOME — the config alone leaves it reporting
  // "Not logged in". Its file form is the documented fallback, so hand it one,
  // inside the 0700 temp home the fixture deletes afterwards.
  const credentials = path.join(tempHome, ".claude/.credentials.json");
  execFileSync(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { stdio: ["ignore", fs.openSync(credentials, "w", 0o600), "ignore"] },
  );
}

/** Wait for `predicate` over the pane's flattened scrollback, or throw. */
async function untilScrollback(
  window: Page,
  tempHome: string,
  paneId: string,
  what: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(flatten(scrollback(tempHome, paneId)))) return;
    await window.waitForTimeout(250);
  }
  const tail = scrollback(tempHome, paneId).slice(-2_000);
  throw new Error(`timed out waiting for ${what}. Pane held:\n${tail}`);
}

/** The pane's whole grid — scrollback included — as plain text. */
async function paneText(window: Page, paneId: string): Promise<string> {
  return window.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    if (!handle) throw new Error(`no terminal registered for ${id}`);
    return handle.serialize.serialize({ scrollback: 20_000 });
  }, paneId);
}

/** A size the grid moved to, and when. */
interface GridMove {
  at: number;
  cols: number;
  rows: number;
}

declare global {
  interface Window {
    __gridMoves?: GridMove[];
  }
}

/**
 * Record every size the grid actually moves to, from here on.
 *
 * The grid is driven from the daemon's marker in the output stream (ADR-164),
 * so its moves are the faithful record of what the pty was told — which is why
 * this needs nothing instrumented inside the app beyond a handle on the
 * terminal. `onResize` is public API.
 */
async function recordGridMoves(window: Page, paneId: string): Promise<void> {
  await window.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    if (!handle) throw new Error(`no terminal registered for ${id}`);
    window.__gridMoves = [];
    handle.term.onResize(({ cols, rows }) => {
      window.__gridMoves?.push({ at: performance.now(), cols, rows });
    });
  }, paneId);
}

async function gridMoves(window: Page): Promise<GridMove[]> {
  return window.evaluate(() => window.__gridMoves ?? []);
}

test.describe("claude, resized after its output lands", () => {
  test.skip(!HAVE_CLAUDE, "no Claude Code on this machine");
  test.setTimeout(300_000);

  test("every line Claude printed once stays on screen once", async ({
    app,
    window,
    tempHome,
  }) => {
    seedClaudeConfig(tempHome);

    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-claude-resize");
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);

    // What the pane opened at has to be a size it can actually hold. The
    // measurement divides the box by one cell of the terminal font, and that
    // font is a webfont: a pane that measured before it loaded fitted 47 rows
    // into a box that holds 41 and ran the whole session six rows overflowing.
    // See `lib/terminal-font`.
    expect(
      await paneOverflowPx(window),
      "the pane opened taller than the box it lives in",
    ).toBeLessThanOrEqual(0);

    await runInTerminal(window, `${CLAUDE_BIN} --model sonnet`);

    // A workspace is a fresh git worktree, so its path cannot be pre-trusted
    // in the seeded config — Claude asks about it on first launch, and the
    // default choice is the one we want.
    await untilScrollback(
      window,
      tempHome,
      paneId,
      "the Claude Code prompt or its trust question",
      (t) => t.includes("Welcomeback") || /trust/i.test(t),
      120_000,
    );
    if (/trust/i.test(scrollback(tempHome, paneId))) {
      await window.keyboard.press("Enter");
    }
    await untilScrollback(
      window,
      tempHome,
      paneId,
      "the Claude Code prompt",
      (t) => t.includes("Welcomeback"),
      120_000,
    );
    await window.waitForTimeout(2_000);

    await window.keyboard.type(PROMPT);
    await window.keyboard.press("Enter");

    await untilScrollback(
      window,
      tempHome,
      paneId,
      "the first markers",
      (t) => t.includes(FIRST_MARKER),
      180_000,
    );
    await untilScrollback(
      window,
      tempHome,
      paneId,
      "the last marker",
      (t) => t.includes(LAST_MARKER),
      180_000,
    );
    await window.waitForTimeout(4_000);

    const settled = await paneText(window, paneId);
    await recordGridMoves(window, paneId);

    // The drag comes *after* the output has landed, which is how the bug is
    // reported: 200 lines are on screen once, the window edge moves, and the
    // copies appear.
    await dragWindowSize(app, 16, 600, { sweeps: 4, width: 320, height: 200 });
    await window.waitForTimeout(4_000);

    const text = await paneText(window, paneId);
    const dupesBefore = duplicates(settled);
    const dupesAfter = duplicates(text);
    const moves = await gridMoves(window);
    console.log(
      `[repro] printed ${printed(settled)}/${MARKERS.length},` +
        ` duplicated before ${dupesBefore.length} after ${dupesAfter.length},` +
        ` ${moves.length} grid moves`,
    );
    if (dupesAfter.length)
      console.log(`[repro] ${dupesAfter.slice(0, 20).join(" ")}`);

    // Keep the evidence: the raw byte stream the pane was fed, and the grid it
    // landed in.
    const outDir = path.join(__dirname, "artifacts/claude-resize");
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(
      path.join(tempHome, ".manor/sessions", paneId, "scrollback.bin"),
      path.join(outDir, "scrollback.bin"),
    );
    fs.writeFileSync(
      path.join(outDir, "grid-moves.json"),
      JSON.stringify(moves, null, 2),
    );
    fs.writeFileSync(path.join(outDir, "pane.txt"), text);

    expect(
      printed(settled),
      "Claude never printed the markers — the prompt did not run",
    ).toBeGreaterThan(MARKERS.length / 2);

    // No phantom sizes. A fit that is corrected a few milliseconds later was
    // never a size the pane had, and a program repainting on SIGWINCH has
    // already redrawn its whole screen for it by the time the correction lands
    // — off the top of the screen, where nothing can erase it again. One
    // settled drag step is one grid move.
    const corrected = moves.flatMap((move, i) => {
      const next = moves[i + 1];
      return next && next.at - move.at < PHANTOM_WINDOW_MS
        ? [`${move.cols}x${move.rows}`]
        : [];
    });
    expect(corrected, "sizes the pty was told and then told again").toEqual([]);

    expect(dupesBefore, "duplicated before anything was resized").toEqual([]);
    expect(
      await paneOverflowPx(window),
      "the pane ended the drag taller than its box",
    ).toBeLessThanOrEqual(0);

    // The drag's own floor is the terminal's, not manor's. This guards the
    // distance from it, which is the part manor owns.
    expect(
      dupesAfter.length,
      `duplicated well past the local-terminal floor: ${dupesAfter.join(" ")}`,
    ).toBeLessThanOrEqual(DUPLICATE_CEILING);
  });
});
