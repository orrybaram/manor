import { expect, type Locator, type Page } from "@playwright/test";

import type { Filmstrip } from "./filmstrip";

/**
 * Driving Manor's Settings modal: the agent command a project launches, and
 * the whole remote-control surface — turning it on (which starts the relay,
 * on Hosts → This Mac), turning it off, and pairing and revoking a device
 * (on Devices; ADR-206, ADR-207, ADR-233).
 *
 * Everything here goes through the app's own UI on purpose. A token minted any
 * other way, or an agent command written straight to disk, would not prove the
 * flow a user actually walks works.
 */

export async function openSettings(window: Page): Promise<void> {
  const modal = window.getByTestId("settings-modal");
  if (await modal.isVisible().catch(() => false)) return;
  // Retried: a test that opens Settings straight after launch can press the
  // shortcut while the splash screen is still up, before the handler exists.
  await expect(async () => {
    if (!(await modal.isVisible())) {
      await window.keyboard.press("ControlOrMeta+,");
    }
    await expect(modal).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

export async function closeSettings(window: Page): Promise<void> {
  const modal = window.getByTestId("settings-modal");
  if (!(await modal.isVisible().catch(() => false))) return;
  await window.keyboard.press("Escape");
  await expect(modal).not.toBeVisible({ timeout: 5_000 });
}

/** Open Settings → Hosts. Leaves the modal open. */
export async function openHostsSettings(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByTestId("settings-nav-hosts").click();
  await expect(window.getByTestId("hosts-page")).toBeVisible({
    timeout: 5_000,
  });
}

/** Open a collapsed host row's body; a row already open is left alone. */
async function expandRow(row: Locator): Promise<void> {
  await expect(row).toBeVisible({ timeout: 10_000 });
  const toggle = row.getByTestId("host-row-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/**
 * Open Settings → Hosts and expand one remote host's row (ADR-233 D1): by id
 * when the spec knows it, else by the name on its header (an ssh target, or a
 * label). Returns the row; leaves the modal open.
 */
export async function openHostRow(
  window: Page,
  host: { hostId: string } | { hostName: string },
): Promise<Locator> {
  await openHostsSettings(window);
  const entries = window.getByTestId("host-entry");
  const row =
    "hostId" in host
      ? window.locator(`[data-testid="host-entry"][data-host-id="${host.hostId}"]`)
      : entries.filter({ hasText: host.hostName });
  await expandRow(row);
  return row;
}

/** Open Settings → Hosts with This Mac's row expanded. Leaves the modal open. */
export async function openRemoteControlSettings(window: Page): Promise<void> {
  await openHostsSettings(window);
  await expandRow(window.getByTestId("host-local"));
  await expect(window.getByTestId("remote-control-switch")).toBeVisible({
    timeout: 5_000,
  });
}

/** Open Settings → Devices. Leaves the modal open. */
export async function openDevicesSettings(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByTestId("settings-nav-devices").click();
  await expect(window.getByTestId("remote-add-device")).toBeVisible({
    timeout: 5_000,
  });
}

/**
 * Turn remote control on — one switch that also starts the relay — and wait
 * until the card says it is live (ADR-206 D6). Leaves Settings open.
 *
 * Goes through the confirmation dialog, which is the point: turning it on is
 * an explicit, confirmed action, and a test that could skip it would not
 * notice if it stopped being one.
 */
export async function enableRemoteControl(window: Page): Promise<void> {
  await openRemoteControlSettings(window);

  const card = window.getByTestId("remote-relay-card");
  const toggle = window.getByTestId("remote-control-switch");
  await expect(toggle).toBeEnabled({ timeout: 10_000 });
  if ((await toggle.getAttribute("data-state")) !== "checked") {
    await toggle.click();
    const confirm = window.getByTestId("remote-relay-confirm");
    await expect(confirm).toBeVisible({ timeout: 5_000 });
    await confirm.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(confirm).not.toBeVisible({ timeout: 5_000 });
  } else {
    // On but the relay gave up: retry it.
    const retry = card.getByTestId("remote-relay-retry");
    if (await retry.isVisible().catch(() => false)) await retry.click();
  }
  await expect(card).toContainText("Remote control is on", {
    timeout: 30_000,
  });
}

/**
 * Point a project at a different agent command, through the same Settings UI
 * a user would use — not a seeded `projects.json`, which would fabricate the
 * state the remote-control suite otherwise earns through the app itself.
 *
 * `ProjectSettingsPage` gives the field no test id, so it is found the way a
 * user finds it: by the label next to it.
 */
export async function setAgentCommand(
  window: Page,
  projectName: string,
  command: string,
): Promise<void> {
  await openSettings(window);
  await window.getByRole("button", { name: projectName, exact: true }).click();

  const input = window
    .getByTestId("settings-modal")
    .locator('label:text("Agent Command") + input');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(command);
  await input.blur();
  // Left open, a global shortcut like "new workspace" cannot reach the main
  // window — the modal traps focus, same as every other settings helper here
  // that does not document leaving it open on purpose.
  await closeSettings(window);
}

/** Bring the relay back up after `stopRelay`: the same switch. */
export async function startRelay(window: Page): Promise<void> {
  await enableRemoteControl(window);
}

/**
 * Turn remote control off, which stops the relay with it. Leaves Settings
 * open.
 */
export async function stopRelay(window: Page): Promise<void> {
  await openRemoteControlSettings(window);
  const toggle = window.getByTestId("remote-control-switch");
  await expect(toggle).toHaveAttribute("data-state", "checked");
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-state", "unchecked", {
    timeout: 10_000,
  });
}

export interface PairedDevice {
  label: string;
  /**
   * The single-use pairing ticket in the link (ADR-240 D1). The device's
   * long-lived token is never in the link: the browser chooses it, so read it
   * from the browser with `deviceToken` once the page has loaded.
   */
  ticket: string;
  /** `<relay-origin>/app/<version>/#relay=<roomId>.<key>&ticket=<ticket>`. */
  link: string;
}

/** The room a pairing link dials: `#relay=<roomId>.<key>&ticket=<ticket>`. */
export function roomOf(link: string): string {
  const relay = new URLSearchParams(new URL(link).hash.slice(1)).get("relay") ?? "";
  return relay.slice(0, relay.indexOf("."));
}

/**
 * The pairing ticket a link carries, failing loudly on a link that carries a
 * raw token (`t=`) instead: since ADR-240 no link the desktop or a host
 * server mints for a person holds the long-lived token.
 */
function ticketOf(link: string, what: string): string {
  const params = new URLSearchParams(new URL(link).hash.slice(1));
  if (params.has("t")) throw new Error(`${what} link carried a raw token`);
  const ticket = params.get("ticket") ?? "";
  if (!ticket) throw new Error(`${what} link carried no pairing ticket`);
  return ticket;
}

/**
 * The long-lived token a browser chose for the pairing `link` names (ADR-240
 * D5), read from its stored pairings once the page has loaded and stored it.
 */
export async function deviceToken(page: Page, link: string): Promise<string> {
  const room = roomOf(link);
  let token = "";
  await expect
    .poll(
      async () => {
        token = await page.evaluate((roomId) => {
          const raw = localStorage.getItem("manor.web.pairings");
          const list = raw ? (JSON.parse(raw) as { roomId: string; token: string }[]) : [];
          return list.find((p) => p.roomId === roomId)?.token ?? "";
        }, room);
        return token;
      },
      { timeout: 15_000, message: `a stored pairing for room ${room}` },
    )
    .not.toBe("");
  return token;
}

/**
 * Pair a device through the UI (ADR-206 D3, ADR-207 D4) and capture the link
 * the dialog hands over once, and the pairing ticket inside it. Every device
 * is a relay device that reaches the whole app, so the Add device dialog is a
 * name and a button.
 *
 * Takes the recorder because the pairing dialog is the one moment the link
 * and its QR code exist on screen, and this function owns that lifetime — a
 * caller has nowhere to photograph it from.
 */
export async function pairDevice(
  window: Page,
  { label, film }: { label: string; film?: Filmstrip },
): Promise<PairedDevice> {
  await openDevicesSettings(window);

  await window.getByTestId("remote-add-device").click();
  return completePairingDialog(window, label, film);
}

/**
 * The rest of pairing, after a trigger has opened the Add device dialog:
 * name it, submit, read the link and ticket off the pairing dialog, close it,
 * and wait for the device's row on the Devices page.
 */
async function completePairingDialog(
  window: Page,
  label: string,
  film?: Filmstrip,
): Promise<PairedDevice> {
  const addDialog = window.getByTestId("remote-add-device-dialog");
  await expect(addDialog).toBeVisible({ timeout: 5_000 });
  await addDialog.getByTestId("remote-pair-label").fill(label);
  await addDialog.getByTestId("remote-pair-submit").click();

  const dialog = window.getByTestId("remote-pairing-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await film?.shot(window, "settings-pairing-link");
  // The dialog shows only the QR code and a Copy link button; the link rides
  // on the button's `data-link`, and the ticket in the link's fragment.
  const link =
    (await window
      .getByTestId("remote-pairing-link")
      .getAttribute("data-link")) ?? "";
  if (!link.includes("#relay=")) {
    throw new Error(`Pairing dialog showed no relay link (got "${link}")`);
  }
  const ticket = ticketOf(link, "Pairing");

  await window.getByTestId("remote-pairing-done").click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });

  // A paired device that does not appear in the list cannot be revoked, so
  // the row is part of pairing rather than a separate thing to check for.
  await expect(
    window.getByTestId("remote-device-row").filter({ hasText: label }),
  ).toHaveCount(1, { timeout: 10_000 });

  return { label, ticket, link };
}

/**
 * Everything a browser needs before it can open the web app: remote control
 * on (the relay running), and a device paired. Returns the device; its `link`
 * is what `openWebApp` opens. Leaves Settings open.
 */
export async function pairBrowser(
  window: Page,
  options: { label: string; film?: Filmstrip },
): Promise<PairedDevice> {
  await enableRemoteControl(window);
  return pairDevice(window, options);
}

/**
 * Pair a device with a remote host's own Manor server alone (ADR-225 D3): the
 * pairing is minted on the box and the link names the box's own room. Settings
 * has no button for this since ADR-233 (a device pairs on Devices and reaches
 * every host that allows devices), so the pairing goes through the host
 * bridge, which still serves it. First waits, on that host's row of Settings
 * → Hosts, until its server says its relay is connected, so the link works as
 * soon as it is opened. Leaves Settings open.
 */
export async function pairHostPhone(
  window: Page,
  { hostName, label }: { hostName: string; label: string },
): Promise<PairedDevice> {
  const row = await openHostRow(window, { hostName });
  const summary = row.getByTestId("host-phone-summary");
  await expect(summary).toContainText("relay connected", { timeout: 60_000 });
  await expect(summary).not.toContainText("relay not connected");

  const hostId = await row.getAttribute("data-host-id");
  if (!hostId) throw new Error(`Host row "${hostName}" carried no host id`);
  const link = await window.evaluate(
    async ([id, name]) => (await window.electronAPI.hosts.pairDevice(id, name)).pairingUrl,
    [hostId, label] as const,
  );
  if (!link.includes("#relay=")) {
    throw new Error(`Host pairing showed no relay link (got "${link}")`);
  }
  const ticket = ticketOf(link, "Host pairing");
  return { label, ticket, link };
}

/** Revoke a paired device by its label, from its row's trash button. */
export async function revokeDevice(window: Page, label: string): Promise<void> {
  await openDevicesSettings(window);
  await window
    .getByTestId("remote-device-row")
    .filter({ hasText: label })
    .getByRole("button", { name: `Revoke ${label}`, exact: true })
    .click();
  await expect(
    window.getByTestId("remote-device-row").filter({ hasText: label }),
  ).toHaveCount(0, { timeout: 10_000 });
}
