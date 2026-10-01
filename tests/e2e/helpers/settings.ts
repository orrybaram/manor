import { expect, type Page } from "@playwright/test";

import type { Filmstrip } from "./filmstrip";

/**
 * Driving Manor's Settings modal: the agent command a project launches, and
 * the whole remote-control surface (ADR-161) — enabling the listener, reading
 * back the address it bound, and pairing a device.
 *
 * Everything here goes through the app's own UI on purpose. A token minted any
 * other way, or an agent command written straight to disk, would not prove the
 * flow a user actually walks works.
 */

export async function openSettings(window: Page): Promise<void> {
  const modal = window.getByTestId("settings-modal");
  if (await modal.isVisible().catch(() => false)) return;
  await window.keyboard.press("ControlOrMeta+,");
  await expect(modal).toBeVisible({ timeout: 10_000 });
}

export async function closeSettings(window: Page): Promise<void> {
  const modal = window.getByTestId("settings-modal");
  if (!(await modal.isVisible().catch(() => false))) return;
  await window.keyboard.press("Escape");
  await expect(modal).not.toBeVisible({ timeout: 5_000 });
}

/** Open Settings → Remote control. Leaves the modal open. */
export async function openRemoteControlSettings(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByTestId("settings-nav-remote").click();
  await expect(window.getByTestId("remote-control-switch")).toBeVisible({
    timeout: 5_000,
  });
}

/**
 * Turn the listener on and return the port it bound.
 *
 * The port is read out of the address the settings page shows, which is the
 * same string a user would copy — if that line is wrong or missing, this fails
 * for the same reason the user would be stuck.
 */
export async function enableRemoteControl(window: Page): Promise<number> {
  await openRemoteControlSettings(window);

  const toggle = window.getByTestId("remote-control-switch");
  await expect(toggle).toBeEnabled({ timeout: 10_000 });
  if ((await toggle.getAttribute("data-state")) !== "checked") {
    await toggle.click();
  }

  const address = window.getByTestId("remote-listener-address");
  await expect(address).toBeVisible({ timeout: 10_000 });
  const text = ((await address.textContent()) ?? "").trim();
  const match = /:(\d+)$/.exec(text);
  if (!match) throw new Error(`Could not read a port out of "${text}"`);
  return Number(match[1]);
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

/** Mirrors `RemoteCapability` in `src/electron.d.ts` (ADR-178 D3). */
export type PairedCapability = "read" | "send" | "full";

/** The tier picker's buttons, as a reader sees them. */
const CAPABILITY_BUTTON: Record<PairedCapability, string> = {
  read: "Watch",
  send: "Reply",
  full: "Everything",
};

export interface PairedDevice {
  label: string;
  token: string;
  capability: PairedCapability;
}

/**
 * Pair a device through the UI and capture the one-time token.
 *
 * Takes the recorder because the pairing dialog is the one moment the token
 * and its QR code exist on screen, and this function owns that lifetime — a
 * caller has nowhere to photograph it from.
 */
export async function pairDevice(
  window: Page,
  {
    label,
    capability,
    film,
  }: { label: string; capability: PairedCapability; film?: Filmstrip },
): Promise<PairedDevice> {
  await openRemoteControlSettings(window);

  // Tailscale is the default road (the relay always means Everything, which
  // is never the default — ADR-178 D3), but say so rather than lean on it.
  await window
    .getByTestId("remote-pair-via")
    .getByRole("button", { name: "Tailscale", exact: true })
    .click();
  await window.getByTestId("remote-pair-label").fill(label);
  // Clicked even for `read`, which is already the default: the assertion that
  // matters is that the button a user would press exists and selects the tier.
  await window
    .getByTestId("remote-pair-capability")
    .getByRole("button", { name: CAPABILITY_BUTTON[capability], exact: true })
    .click();
  await window.getByTestId("remote-pair-submit").click();

  const dialog = window.getByTestId("remote-pairing-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await film?.shot(window, "settings-pairing-token");
  const token = (
    (await window.getByTestId("remote-pairing-token").textContent()) ?? ""
  ).trim();
  if (!token) throw new Error("Pairing dialog showed no token");

  await window.getByTestId("remote-pairing-done").click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });

  // A paired device that does not appear in the list cannot be revoked, so
  // the row is part of pairing rather than a separate thing to check for.
  await expect(
    window.getByTestId("remote-device-row").filter({ hasText: label }),
  ).toHaveCount(1);

  return { label, token, capability };
}

/**
 * Start the Manor relay from its card and wait until the card says the
 * machine is reachable through it (ADR-206 D6). Leaves Settings open.
 *
 * Goes through the confirmation dialog, which is the point: starting the
 * relay is an explicit, confirmed action, and a test that could skip it
 * would not notice if it stopped being one.
 */
export async function startRelay(window: Page): Promise<void> {
  await openRemoteControlSettings(window);
  const card = window.getByTestId("remote-relay-card");
  await card.getByTestId("remote-relay-start").click();
  const confirm = window.getByTestId("remote-relay-confirm");
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  await confirm
    .getByRole("button", { name: "Start relay", exact: true })
    .click();
  await expect(confirm).not.toBeVisible({ timeout: 5_000 });
  await expect(card).toContainText("Reachable through the Manor relay", {
    timeout: 30_000,
  });
}

/** Stop the relay from its card. Leaves Settings open. */
export async function stopRelay(window: Page): Promise<void> {
  await openRemoteControlSettings(window);
  const card = window.getByTestId("remote-relay-card");
  await card.getByTestId("remote-relay-stop").click();
  await expect(card.getByTestId("remote-relay-start")).toBeVisible({
    timeout: 10_000,
  });
}

export interface RelayPairedDevice {
  label: string;
  token: string;
  /** `<relay-origin>/app/<version>/#relay=<roomId>.<key>&t=<token>`. */
  link: string;
}

/**
 * Pair a device through the relay (ADR-206 D3) and capture the link and
 * token the dialog shows once. The relay has to be chosen explicitly — it is
 * not the default — and a relay device is always Everything, so there is no
 * tier to pick: the picker is replaced by the full-tier warning, and this
 * checks it is.
 */
export async function pairDeviceViaRelay(
  window: Page,
  { label, film }: { label: string; film?: Filmstrip },
): Promise<RelayPairedDevice> {
  await openRemoteControlSettings(window);

  await window
    .getByTestId("remote-pair-via")
    .getByRole("button", { name: "Manor relay", exact: true })
    .click();
  await expect(window.getByTestId("remote-pair-capability")).toHaveCount(0);
  await expect(window.getByTestId("remote-pair-relay-warning")).toContainText(
    "always gets Everything",
  );

  await window.getByTestId("remote-pair-label").fill(label);
  await window.getByTestId("remote-pair-submit").click();

  const dialog = window.getByTestId("remote-pairing-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await film?.shot(window, "settings-relay-pairing");
  const token = (
    (await window.getByTestId("remote-pairing-token").textContent()) ?? ""
  ).trim();
  const link = (
    (await window.getByTestId("remote-pairing-link").textContent()) ?? ""
  ).trim();
  if (!token) throw new Error("Pairing dialog showed no token");
  if (!link.includes("#relay=")) {
    throw new Error(`Pairing dialog showed no relay link (got "${link}")`);
  }

  await window.getByTestId("remote-pairing-done").click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });

  const row = window
    .getByTestId("remote-device-row")
    .filter({ hasText: label });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("via relay");

  return { label, token, link };
}

/** Revoke a paired device by its label, from its row's trash button. */
export async function revokeDevice(window: Page, label: string): Promise<void> {
  await openRemoteControlSettings(window);
  await window
    .getByTestId("remote-device-row")
    .filter({ hasText: label })
    .getByRole("button", { name: `Revoke ${label}`, exact: true })
    .click();
  await expect(
    window.getByTestId("remote-device-row").filter({ hasText: label }),
  ).toHaveCount(0, { timeout: 10_000 });
}
