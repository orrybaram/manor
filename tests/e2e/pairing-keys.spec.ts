import { expect, test } from "./fixtures";
import { Filmstrip } from "./helpers/filmstrip";
import {
  APP_TARGET,
  onRemote,
  pollFor,
  remoteSkipReason,
  resetRemoteBox,
} from "./helpers/remote-host";
import { CONNECT_TIMEOUT, STEP, hostStatus } from "./helpers/remote-project";
import { openHostRow, openHostsSettings } from "./helpers/settings";

/**
 * Pairing-key encryption on a real ssh box (ADR-236 D6), against the
 * harness's private sshd:
 *
 * 1. A host registered outside the wizard arrives on plaintext keys. Its row
 *    on Settings → Hosts says **Pairing keys · Unencrypted** with a primary
 *    **Encrypt** button. The click reads **Encrypting…** while the box's
 *    server restarts, then **Encrypted** with the key's path, and the box's
 *    own `manor-host secrets status` agrees.
 * 2. The Add a host wizard encrypts a new ssh host by itself: its last step
 *    goes from Encrypting… to Encrypted with no click.
 *
 * Each step is photographed into tests/e2e/artifacts/pairing-keys/.
 *
 * Skipped unless MANOR_E2E_SSH=1. Run through the harness:
 *
 *   node scripts/test-remote-e2e.mjs --playwright-only -- --grep "pairing keys"
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  // A clean `~/.manor/remote` on the box: its recorded backend and
  // `supervisor.env` go with it, so every test starts from plaintext.
  resetRemoteBox();
});

/** What the box itself records, from `manor-host secrets status --json`. */
function remoteSecrets(): { backend: string | null; keyFile: string | null; place: string | null } {
  const out = onRemote('"$HOME/.manor/bin/manor-host" secrets status --json').stdout.trim();
  return JSON.parse(out).secrets;
}

test.describe("pairing keys", () => {
  test("the Hosts page row: Unencrypted, Encrypt, Encrypting…, Encrypted", async ({ window }) => {
    const film = new Filmstrip("pairing-keys-row");

    // Registering the host is Project Settings → Host in the UI; it has no
    // bearing on what this test shows, so it goes straight through the API.
    const { hostId } = await window.evaluate(
      (target) => window.electronAPI.hosts.add(target),
      APP_TARGET,
    );
    await pollFor(
      `${APP_TARGET} connected`,
      async () => {
        const host = await hostStatus(window, hostId);
        if (host?.status === "error") throw new Error(`host failed: ${host.error}`);
        return host?.status === "connected" ? host : null;
      },
      CONNECT_TIMEOUT,
      500,
    );

    const row = await openHostRow(window, { hostId });
    const state = row.getByTestId("host-pairing-keys-state");
    await expect(state).toHaveText("Unencrypted", { timeout: STEP });
    expect(remoteSecrets().backend).toBe("plaintext");
    await expect(row.getByTestId("host-row-status")).toContainText("pairing keys unencrypted");
    await expect(row.getByTestId("host-encrypt-keys")).toBeEnabled();
    await film.shot(window, "row-unencrypted");

    await row.getByTestId("host-pairing-keys-more").click();
    await expect(row.getByTestId("host-pairing-keys-detail")).toContainText("secret.key");
    await expect(row.getByTestId("host-pairing-keys-detail")).toBeVisible();
    await film.shot(window, "row-what-this-protects");

    await row.getByTestId("host-encrypt-keys").click();
    await expect(state).toHaveText("Encrypting…", { timeout: 10_000 });
    await expect(row.getByTestId("host-encrypt-keys")).toBeDisabled();
    await film.shot(window, "row-encrypting");

    await expect(state).toHaveText("Encrypted", { timeout: STEP });
    await expect(row.getByTestId("host-pairing-keys-hint")).toContainText("manor/secret.key");
    await expect(row.getByTestId("host-row-status")).not.toContainText("unencrypted");
    await expect(row.getByTestId("host-entry-error")).toHaveCount(0);
    await film.shot(window, "row-encrypted");

    const after = remoteSecrets();
    expect(after.backend).toBe("key-file");
    expect(after.place).toBe("home");
    film.write("secrets-status.json", JSON.stringify(after, null, 2));

    await row.getByTestId("host-pairing-keys-more").click();
    await expect(row.getByTestId("host-pairing-keys-detail")).toContainText("Reset pairing keys");
    await expect(row.getByTestId("host-pairing-keys-detail")).toBeVisible();
    await film.shot(window, "row-encrypted-details");
  });

  test("the Add a host wizard encrypts a new ssh host by itself", async ({ window }) => {
    const film = new Filmstrip("pairing-keys-wizard");

    await openHostsSettings(window);
    await window.getByTestId("hosts-add").click();
    await window.getByTestId("hosts-add-ssh").click();
    await window.getByTestId("add-host-continue").click();
    await window.getByTestId("add-ssh-host-target").fill(APP_TARGET);
    await film.shot(window, "wizard-connect");
    await window.getByTestId("add-ssh-host-connect").click();

    await expect(window.getByTestId("add-host-ready")).toContainText("is ready", {
      timeout: CONNECT_TIMEOUT,
    });
    const state = window.getByTestId("host-pairing-keys-state");
    // The automatic step starts as soon as the server reports plaintext; the
    // restart takes a few seconds, long enough to photograph.
    await expect(state).toHaveText(/Encrypting…|Encrypted/, { timeout: STEP });
    await film.shot(window, "wizard-encrypting");
    await expect(state).toHaveText("Encrypted", { timeout: STEP });
    await expect(window.getByTestId("host-encrypt-keys")).toHaveCount(0);
    await film.shot(window, "wizard-encrypted");

    const after = remoteSecrets();
    expect(after.backend).toBe("key-file");
    film.write("secrets-status.json", JSON.stringify(after, null, 2));

    await window.getByTestId("add-host-done").click();
    const row = window.locator('[data-testid="host-entry"]').filter({ hasText: APP_TARGET });
    await expect(row.getByTestId("host-pairing-keys-state")).toHaveText("Encrypted", {
      timeout: STEP,
    });
    await film.shot(window, "row-after-wizard");

    // The same row in a light theme: the pills are drawn from the theme's own
    // yellow and green, so they have to read on a light background too.
    const lightTheme = await window.evaluate(async () => {
      const all = await window.electronAPI.theme.allColors();
      const luminance = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const light = Object.entries(all)
        .filter(([, c]) => luminance(c.background) > 0.7)
        .map(([name]) => name)
        .sort()[0];
      if (!light) throw new Error("no light theme to switch to");
      await window.electronAPI.theme.setSelected(light);
      return light;
    });
    await expect
      .poll(
        () =>
          window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()),
        { timeout: 10_000 },
      )
      .not.toBe("#1e1e2e");
    film.write("light-theme.txt", lightTheme);
    await row.getByTestId("host-pairing-keys-more").click();
    await expect(row.getByTestId("host-pairing-keys-detail")).toBeVisible();
    await film.shot(window, "row-after-wizard-light");
  });
});
