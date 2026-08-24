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
} from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import {
  readSession,
  waitForVisibleSession,
  type TaskSummary,
} from "./helpers/local-api";
import { openPhoneClient, sessionRow, type Phone } from "./helpers/phone";
import {
  closeSettings,
  enableRemoteControl,
  openRemoteControlSettings,
  pairDevice,
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
/** Passed to the fake agent, which puts it in the window title → the task name. */
const AGENT_TITLE = "e2e-agent";
/** The project `tempHome` is seeded with, as the client labels its sessions. */
const PROJECT_NAME = "test-project";

interface Paired {
  session: TaskSummary;
  phone: Phone;
  device: PairedDevice;
  port: number;
}

/**
 * Everything up to a live phone: a running session, the listener on, a device
 * paired, and the client loaded with its token.
 *
 * The agent is started by typing into a terminal rather than through Cmd+N,
 * and that is the difference between a deterministic test and a flaky one.
 * Cmd+N consumes Manor's prewarmed session, which boots the project's agent
 * command in the background *before* the pane exists — so its task row is
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
  }: { label: string; canSend: boolean; film?: Filmstrip },
): Promise<Paired> {
  await importSeededProject(app, window, tempHome);
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
});
