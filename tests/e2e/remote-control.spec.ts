import fs from "fs";
import path from "path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";

import {
  createWorkspace,
  importSeededProject,
  openTerminalTab,
  test,
} from "./fixtures";
import {
  FAKE_AGENT,
  FAKE_AGENT_BANNER,
  FAKE_AGENT_ECHO,
  FAKE_AGENT_RULER,
  FAKE_AGENT_RULER_ROW,
} from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import {
  readSession,
  waitForVisibleSession,
  type AgentSummary,
} from "./helpers/local-api";
import { openPhoneClient, sessionRow, type Phone } from "./helpers/phone";
import {
  closeSettings,
  enableRemoteControl,
  openRemoteControlSettings,
  pairDevice,
  setAgentCommand,
  type PairedDevice,
} from "./helpers/settings";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
} from "./helpers/terminal";

/**
 * ADR-161 end to end: a session in the app, a device paired through settings,
 * and the phone client driving it over the authenticated listener.
 *
 * Nothing here reaches inside the app to fabricate state. The session comes
 * from an agent reporting its own lifecycle over the hook endpoint, the token
 * comes from the pairing dialog, and the client is an ordinary browser page
 * that knows nothing but an address and a bearer token — which is the whole
 * claim the feature makes.
 */

const HOLD_MS = Number(process.env.MANOR_E2E_HOLD ?? 0) * 1000;
const HEADED = process.env.MANOR_E2E_HEADED === "1";
/** Passed to the fake agent, which puts it in the window title → the agent name. */
const AGENT_TITLE = "e2e-agent";
/** The project `tempHome` is seeded with, as the client labels its sessions. */
const PROJECT_NAME = "test-project";

interface Paired {
  session: AgentSummary;
  phone: Phone;
  device: PairedDevice;
  port: number;
}

/**
 * Mirrors `trimBlankRows` in `src/remote-client/ansi.ts`: `/sessions/read`
 * hands back the whole screen grid, and the client drops the blank rows below
 * the last real line before painting one. A row count measured off the DOM
 * has to be compared against the same trimmed count, not the raw payload's.
 */
function visibleLineCount(rawText: string): number {
  const lines = rawText.split("\n");
  let end = lines.length;
  while (end > 0 && stripSgr(lines[end - 1]).trim() === "") end--;
  return end;
}

function stripSgr(line: string): string {
  return line.replace(/\u001b\[[\d;]*m/g, "");
}

/** One line of `RemoteAuditLog` (`electron/remote-control/audit.ts`). */
interface AuditEntry {
  route: string;
  target: string | null;
  textLength: number | null;
  textSha256: string | null;
  outcome: "sent" | "rejected" | "failed";
}

/** Where main writes the remote-control audit trail — mirrors `remoteAuditFile()` in `electron/paths.ts`. */
function auditFile(tempHome: string): string {
  const dataDir =
    process.platform === "darwin"
      ? path.join(tempHome, "Library", "Application Support", "Manor")
      : path.join(tempHome, ".local", "share", "Manor");
  return path.join(dataDir, "remote-audit.jsonl");
}

/** Every audit line written so far. Malformed or missing is read as none. */
function auditEntries(tempHome: string): AuditEntry[] {
  const file = auditFile(tempHome);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

/**
 * Everything up to a live phone: a running session, the listener on, a device
 * paired, and the client loaded with its token.
 *
 * The agent is started by typing into a terminal rather than through Cmd+N,
 * and that is the difference between a deterministic test and a flaky one.
 * Cmd+N consumes Manor's prewarmed session, which boots the project's agent
 * command in the background *before* the pane exists — so its agent row is
 * created with no project and no name, and a second, still-warm prewarm shows
 * up as a session of its own. Typing into a pane that is already on screen
 * gives the hook relay the context it needs the first time.
 */
async function pairedPhone(
  app: ElectronApplication,
  window: Page,
  tempHome: string,
  request: APIRequestContext,
  {
    label,
    canSend,
    film,
    agentCommand,
  }: {
    label: string;
    canSend: boolean;
    film?: Filmstrip;
    /** Set before anything asks Manor to start a process on its own — a
     *  launch (ADR-177) spawns the *project's* agent command, not whatever
     *  this fixture types into a pane by hand. */
    agentCommand?: string;
  },
): Promise<Paired> {
  await importSeededProject(app, window, tempHome);
  if (agentCommand) await setAgentCommand(window, PROJECT_NAME, agentCommand);
  await createWorkspace(window, "remote-e2e");
  await openTerminalTab(window);

  await awaitShellReady(window, tempHome, await activePaneId(window));
  await runInTerminal(window, `"${FAKE_AGENT}" ${AGENT_TITLE}`);
  // Observed over the local control surface, not the terminal: xterm draws
  // into a WebGL canvas, so there is no DOM text to assert on.
  const session = await waitForVisibleSession(request, tempHome, {
    name: AGENT_TITLE,
  });

  const port = await enableRemoteControl(window);
  await film?.shot(window, "settings-remote-enabled");
  const device = await pairDevice(window, { label, canSend, film });
  // Shot before the modal closes: the paired-device row only exists here.
  await film?.shot(window, "settings-device-paired");
  await closeSettings(window);

  const phone = await openPhoneClient(port, device.token, { headed: HEADED });
  return { session, phone, device, port };
}

test.describe("remote control", () => {
  // The hold is time spent deliberately idle with both windows up, so it has
  // to be added to the budget rather than eaten out of it.
  test.setTimeout(240_000 + HOLD_MS);

  test("pair a phone, read a session, send to it", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("remote-control");

    const { session, phone, device } = await pairedPhone(
      app,
      window,
      tempHome,
      request,
      { label: "e2e phone", canSend: true, film },
    );

    try {
      const row = sessionRow(phone.page, {
        name: AGENT_TITLE,
        project: PROJECT_NAME,
      });
      await expect(row).toBeVisible({ timeout: 30_000 });
      // The fake agent parks in requires_input, which is the state the whole
      // feature exists to surface, so the row must read as blocked.
      await expect(row).toHaveClass(/blocked/);
      await expect(row).toContainText("requires input");
      await film.shot(phone.page, "phone-session-list");

      // The token must not survive in the address bar.
      expect(phone.page.url()).not.toContain(device.token);

      // A send-capable device gets the "+" that starts a new session
      // (ADR-177); the read-only test below asserts its absence.
      await expect(phone.page.locator("button.add")).toBeVisible();

      await row.click();
      await expect(phone.page.locator("pre.terminal")).toContainText(
        FAKE_AGENT_BANNER,
        { timeout: 20_000 },
      );
      await film.shot(phone.page, "phone-session-detail");

      // ── Sending, which is the part that types into a live shell ──
      const message = "hello from the phone";
      await phone.page.locator(".composer input").fill(message);
      await phone.page.getByRole("button", { name: "Send" }).first().click();

      const sheet = phone.page.locator(".sheet");
      await expect(sheet).toBeVisible();
      // The confirmation has to name the exact text and the exact session.
      await expect(sheet).toContainText(message);
      await film.shot(phone.page, "phone-send-confirm");

      await sheet.getByRole("button", { name: "Send" }).click();
      await expect(phone.page.locator(".banner")).toContainText("Sent.", {
        timeout: 3_000,
      });

      // No interaction here, deliberately: an open transcript re-reads itself,
      // so the agent's reply has to arrive on its own. Nothing in this client
      // asks to be refreshed.
      await expect(phone.page.locator("pre.terminal")).toContainText(
        `${FAKE_AGENT_ECHO} ${message}`,
        { timeout: 30_000 },
      );
      await film.shot(phone.page, "phone-send-landed");

      // The transcript is a terminal, not stripped text: the agent's coloured
      // output survives as colour.
      const coloured = phone.page.locator("pre.terminal span").first();
      await expect(coloured).toHaveCount(1);
      expect(
        await coloured.evaluate((node) => getComputedStyle(node).color),
      ).not.toBe("");

      // It landed in the real session, not just in the client's view: this
      // reads the pty back over the local surface, which the phone never
      // touched.
      await expect
        .poll(() => readSession(request, tempHome, session.id), {
          timeout: 20_000,
        })
        .toContain(`${FAKE_AGENT_ECHO} ${message}`);
      await film.shot(window, "app-after-send");

      // MANOR_E2E_HOLD keeps both windows up here, at the point where the
      // paired phone is live and usable, so the flow can be poked at by hand —
      // and then the test stops. Everything below assumes nobody has touched
      // the app since the assertions above, which is exactly what a hold
      // invites someone to do: revoke the device by hand and the revoke step
      // waits for a button that is already gone.
      if (HOLD_MS > 0) {
        await phone.page.waitForTimeout(HOLD_MS);
        return;
      }

      // ── Revoking is immediate ──
      await openRemoteControlSettings(window);
      await window
        .getByRole("button", { name: `Revoke ${device.label}` })
        .click();
      await expect(window.getByTestId("remote-device-row")).toHaveCount(0);

      await phone.page.reload();
      await expect(phone.page.locator(".empty")).toContainText("not paired", {
        timeout: 20_000,
      });
      await film.shot(phone.page, "phone-revoked");
    } finally {
      film.write("phone-console.log", phone.log.join("\n") + "\n");
      await phone.close();
    }
  });

  test("the open session survives its own live updates", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("remote-control-live");

    const { phone } = await pairedPhone(app, window, tempHome, request, {
      label: "live phone",
      canSend: true,
    });

    try {
      await sessionRow(phone.page, {
        name: AGENT_TITLE,
        project: PROJECT_NAME,
      }).click();
      const terminal = phone.page.locator("pre.terminal");
      await expect(terminal).toContainText(FAKE_AGENT_BANNER, {
        timeout: 20_000,
      });

      // A transcript long enough to scroll, so the reader's position is a real
      // position and not just "the top, which is also the bottom".
      const composer = phone.page.locator(".composer input");
      await composer.fill("spam");
      await phone.page.getByRole("button", { name: "Send" }).first().click();
      await phone.page
        .locator(".sheet")
        .getByRole("button", { name: "Send" })
        .click();
      await expect(terminal).toContainText("line 200", { timeout: 30_000 });

      // Half-typed text, and a caret, must survive the refreshes that happen
      // while someone is typing — on a phone, losing focus dismisses the
      // keyboard mid-sentence.
      await composer.click();
      await composer.pressSequentially("hello ag", { delay: 20 });
      await phone.page.waitForTimeout(4_000);
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("hello ag");

      // And the view must still be where the reader left it: at the bottom,
      // watching, rather than thrown back to the top by its own repaint.
      const fromBottom = await terminal.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      );
      expect(fromBottom).toBeLessThan(24);
      await film.shot(phone.page, "phone-long-transcript");
    } finally {
      film.write("phone-console.log", phone.log.join("\n") + "\n");
      await phone.close();
    }
  });

  test("a read-only device cannot send, by absence and not by refusal", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("remote-control-readonly");

    const { phone, device, port } = await pairedPhone(
      app,
      window,
      tempHome,
      request,
      { label: "read only phone", canSend: false },
    );

    try {
      const row = sessionRow(phone.page, {
        name: AGENT_TITLE,
        project: PROJECT_NAME,
      });
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Starting a session is a write too (ADR-177): the "+" goes with the
      // composer and the actions row, absent rather than merely disabled.
      await expect(phone.page.locator("button.add")).toHaveCount(0);
      await row.click();
      await expect(phone.page.locator("pre.terminal")).toContainText(
        FAKE_AGENT_BANNER,
        { timeout: 20_000 },
      );
      await expect(phone.page.locator(".composer input")).toHaveCount(0);
      // The quick replies and Stop go with it — a read-only device is shown no
      // way to act, not a disabled one.
      await expect(phone.page.locator(".actions")).toHaveCount(0);
      await film.shot(phone.page, "phone-read-only-detail");
    } finally {
      film.write("phone-console.log", phone.log.join("\n") + "\n");
      await phone.close();
    }

    // The route is not on this device's table at all, so it 404s the way an
    // unrouted path does — a read-only token cannot tell that sending exists.
    const denied = await request.post(
      `http://127.0.0.1:${port}/sessions/send`,
      {
        headers: { Authorization: `Bearer ${device.token}` },
        data: { target: "anything", text: "rm -rf /", confirmed: true },
      },
    );
    expect(denied.status()).toBe(404);

    // Interrupt is a write too: stopping an agent throws away its turn, so it
    // is absent from a read-only device's table for the same reason.
    const stopped = await request.post(
      `http://127.0.0.1:${port}/sessions/interrupt`,
      {
        headers: { Authorization: `Bearer ${device.token}` },
        data: { target: "anything", confirmed: true },
      },
    );
    expect(stopped.status()).toBe(404);

    // And the routes that were never allowlisted are absent for everyone.
    const launch = await request.post(`http://127.0.0.1:${port}/agents`, {
      headers: { Authorization: `Bearer ${device.token}` },
      data: { workspacePath: tempHome },
    });
    expect(launch.status()).toBe(404);
  });

  test("a wide grid renders row for row on the phone, not reflowed", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("remote-control-grid");

    const { phone } = await pairedPhone(app, window, tempHome, request, {
      label: "grid phone",
      canSend: true,
      film,
    });

    try {
      const row = sessionRow(phone.page, {
        name: AGENT_TITLE,
        project: PROJECT_NAME,
      });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();

      const terminal = phone.page.locator("pre.terminal");
      const stream = phone.page.locator("pre.terminal .stream");
      await expect(terminal).toContainText(FAKE_AGENT_BANNER, {
        timeout: 20_000,
      });

      // Every payload this session's open transcript fetches from here on,
      // so the one that actually carries the ruler can be picked out after
      // the fact — the poll (`TRANSCRIPT_MS`) keeps firing regardless of
      // exactly when the fixture lands.
      const reads: Promise<{ text: string }>[] = [];
      phone.page.on("response", (res) => {
        if (
          res.request().method() === "POST" &&
          res.url().endsWith("/sessions/read")
        ) {
          reads.push(res.json() as Promise<{ text: string }>);
        }
      });

      // Drawn straight into the real terminal, independent of the remote send
      // path: this is a claim about what `/sessions/read` returns and how the
      // phone renders it, not about sending.
      await runInTerminal(window, FAKE_AGENT_RULER);

      await expect(stream).toContainText(FAKE_AGENT_RULER_ROW, {
        timeout: 20_000,
      });
      await film.shot(phone.page, "phone-grid-fidelity");

      let payload: { text: string } | undefined;
      for (const read of reads) {
        const body = await read;
        if (body.text.includes(FAKE_AGENT_RULER_ROW)) payload = body;
      }
      if (!payload) {
        throw new Error("No /sessions/read response carried the ruler rows");
      }
      const expectedLines = visibleLineCount(payload.text);

      const measured = await stream.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          rows: node.scrollHeight / parseFloat(style.lineHeight),
          fontSize: parseFloat(style.fontSize),
          whiteSpace: style.whiteSpace,
        };
      });

      // The reflow this fixture exists to catch: a wrapped grid renders more
      // visual rows than the payload has lines.
      expect(Math.round(measured.rows)).toBe(expectedLines);
      expect(measured.whiteSpace).toBe("pre");
      // The ticket-5 clamp: never bigger than the old fixed size, never so
      // small nobody could read it.
      expect(measured.fontSize).toBeLessThanOrEqual(12);
      expect(measured.fontSize).toBeGreaterThanOrEqual(6);

      // The two drawn rows are still exactly as wide as each other — column
      // alignment survived the whole pipeline, not just "close enough". A
      // reflow would not show up here (wrapping doesn't touch `textContent`),
      // which is exactly why it is a separate assertion from the row count
      // above rather than a substitute for it. Rows the daemon serializes are
      // `\r\n`-terminated (a real terminal's own line ending), so the split
      // has to eat the `\r` too — otherwise every row but the last would
      // carry a trailing one and never compare equal to
      // `FAKE_AGENT_RULER_ROW`.
      const drawnRows =
        (await stream.textContent())
          ?.split(/\r?\n/)
          .filter((line) => line === FAKE_AGENT_RULER_ROW) ?? [];
      expect(drawnRows.length).toBeGreaterThanOrEqual(2);
      expect(drawnRows[0].length).toBe(drawnRows[1].length);
    } finally {
      film.write("phone-console.log", phone.log.join("\n") + "\n");
      await phone.close();
    }
  });

  test("launching a new session from the phone", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("remote-control-launch");

    const { phone } = await pairedPhone(app, window, tempHome, request, {
      label: "launch phone",
      canSend: true,
      film,
      // A launch spawns this for real (ADR-177), unlike every other session
      // in this file, which is typed straight into a pane.
      agentCommand: `"${FAKE_AGENT}"`,
    });

    try {
      // A workspace nothing is running in yet, to launch into. The one
      // `pairedPhone` already made keeps running the fixture's own session,
      // so "no session running here" has something real to be false about.
      await createWorkspace(window, "phone-launch-target");

      const add = phone.page.locator("button.add");
      await expect(add).toBeVisible({ timeout: 30_000 });

      const workspacesResponse = phone.page.waitForResponse(
        (res) =>
          res.request().method() === "GET" && res.url().endsWith("/workspaces"),
      );
      await add.click();
      const groups = (await (await workspacesResponse).json()) as {
        projectName: string;
        workspaces: {
          path: string;
          branch: string;
          name: string | null;
          isMain: boolean;
        }[];
      }[];
      const project = groups.find((g) => g.projectName === PROJECT_NAME);
      // A custom name is only stored when it differs from the branch
      // (`ProjectManager.createWorktree`); typed as a plain slug, this
      // workspace's name and branch are the same string, so `branch` is what
      // `GET /workspaces` actually carries.
      const targetWorkspace = project?.workspaces.find(
        (w) => w.branch === "phone-launch-target",
      );
      expect(targetWorkspace).toBeTruthy();

      await expect(
        phone.page.locator(".section-heading", { hasText: PROJECT_NAME }),
      ).toBeVisible();
      const targetRow = phone.page
        .locator("li.session")
        .filter({ hasText: "phone-launch-target" });
      await expect(targetRow).toBeVisible();
      await expect(targetRow).not.toContainText("session running");
      await film.shot(phone.page, "phone-new-session-list");

      await targetRow.click();
      const prompt = "say hello from the phone launch";
      await phone.page.locator(".composer input").fill(prompt);
      const launch = phone.page.getByRole("button", { name: "Launch" }).first();
      await expect(launch).toBeEnabled();
      await launch.click();

      const sheet = phone.page.locator(".sheet");
      await expect(sheet).toBeVisible();
      // The confirmation names the exact workspace and the exact prompt.
      await expect(sheet).toContainText("phone-launch-target");
      await expect(sheet).toContainText(prompt);
      await film.shot(phone.page, "phone-launch-confirm");
      await sheet.getByRole("button", { name: "Launch" }).click();

      // A new session exists — proven the same way `pairedPhone` proves the
      // first one, over the app's own local surface. The fake agent's title
      // (and so its name) is set from its own first argument, which is the
      // prompt the launch carried.
      await waitForVisibleSession(request, tempHome, {
        name: prompt,
        timeout: 60_000,
      });

      // The client's one-shot re-read (`mountNewSession`'s launch handler)
      // races the hook relay reporting `SessionStart`, and can lose it —
      // the launch is not undone, only the auto-open is skipped, and the
      // session lands in the list like any other. Either way it must be
      // reachable, not dead: tap it if the race left it on the list.
      const heading = phone.page.locator("h1", { hasText: prompt });
      if (!(await heading.isVisible())) {
        const newRow = sessionRow(phone.page, {
          name: prompt,
          project: PROJECT_NAME,
        });
        await expect(newRow).toBeVisible({ timeout: 10_000 });
        await newRow.click();
      }
      await expect(heading).toBeVisible({ timeout: 20_000 });
      await expect(phone.page.locator("pre.terminal")).toContainText(
        FAKE_AGENT_BANNER,
        { timeout: 20_000 },
      );
      await film.shot(phone.page, "phone-launch-landed");

      // The audit line names the workspace it launched into, and never the
      // prompt itself — only its length and hash, exactly like a send.
      const entries = auditEntries(tempHome).filter(
        (e) => e.route === "POST /agents",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].target).toBe(targetWorkspace!.path);
      expect(entries[0].outcome).toBe("sent");
      expect(entries[0].textLength).toBe(prompt.length);
      expect(JSON.stringify(entries[0])).not.toContain(prompt);
    } finally {
      film.write("phone-console.log", phone.log.join("\n") + "\n");
      await phone.close();
    }
  });
});
