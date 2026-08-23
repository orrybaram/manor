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
  await window.keyboard.press("Meta+,");
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

export interface PairedDevice {
  label: string;
  token: string;
  canSend: boolean;
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
    canSend,
    film,
  }: { label: string; canSend: boolean; film?: Filmstrip },
): Promise<PairedDevice> {
  await openRemoteControlSettings(window);

  await window.getByTestId("remote-pair-label").fill(label);
  if (canSend) await window.getByTestId("remote-pair-can-send").click();
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

  return { label, token, canSend };
}
