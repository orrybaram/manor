/**
 * Web Push for the remote-control surface (ADR-161 §6).
 *
 * The point of the feature is being *told*, not remembering to check. This is
 * a second sink on the transition Manor already computes for the dock badge
 * and OS notifications — it adds no detection of its own, and if the existing
 * signal is wrong this will be wrong in exactly the same way, which is the
 * right coupling.
 *
 * The payload deliberately carries only a session label and a project name. A
 * push reaches the phone's notification shade, where it is visible on a locked
 * screen and retained by the OS; scrollback routinely contains API keys, so
 * none of it goes in here. "Which session, and that it is blocked" is the whole
 * useful content anyway.
 *
 * The VAPID key pair is generated once and kept encrypted next to the device
 * store. Losing it costs every subscription (phones must re-subscribe), which
 * is why it is persisted rather than regenerated per launch.
 */

import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import webpush from "web-push";

import { remoteVapidFile } from "../paths";
import type { PushSubscriptionRecord, RemoteDeviceStore } from "./devices";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushPayload {
  agentId: string;
  title: string;
  body: string;
}

/**
 * The two statuses worth waking a phone for. `requires_input` is the whole
 * premise; `error` is the other way a session goes quiet without finishing.
 */
export type PushableStatus = "requires_input" | "error";

export function isPushable(status: string): status is PushableStatus {
  return status === "requires_input" || status === "error";
}

/** A `mailto:` subject is required by the VAPID spec; nothing is sent to it. */
const VAPID_SUBJECT = "mailto:remote-control@manor.invalid";

export class PushManager {
  private keys: VapidKeys | null = null;
  private loaded = false;

  constructor(
    private readonly devices: RemoteDeviceStore,
    private readonly filePath: string = remoteVapidFile(),
    /** Injected so tests do not talk to a real push service. */
    private readonly send: typeof webpush.sendNotification = (...args) =>
      webpush.sendNotification(...args),
    private readonly generate: () => VapidKeys = () =>
      webpush.generateVAPIDKeys(),
  ) {}

  /**
   * The application server key a client needs to subscribe. Generates the pair
   * on first use; returns null if it cannot be stored safely, which disables
   * push rather than leaving a private key in plaintext.
   */
  publicKey(): string | null {
    try {
      return this.ensureKeys().publicKey;
    } catch {
      return null;
    }
  }

  /** Record a device's subscription. False means there is no such device. */
  subscribe(deviceId: string, subscription: PushSubscriptionRecord): boolean {
    return this.devices.setPushSubscription(deviceId, subscription);
  }

  /**
   * Fan one transition out to every subscribed device.
   *
   * Returns the number of pushes actually sent, which is what the tests assert
   * on. An endpoint the service has retired (404/410) is dropped silently —
   * that is the normal end of a subscription's life, not an error worth
   * surfacing to anyone.
   */
  async notify(payload: PushPayload): Promise<number> {
    let keys: VapidKeys;
    try {
      keys = this.ensureKeys();
    } catch {
      return 0;
    }

    const targets = this.devices.pushTargets();
    let sent = 0;
    await Promise.all(
      targets.map(async ({ device, subscription }) => {
        try {
          await this.send(
            {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
            },
            JSON.stringify(payload),
            {
              vapidDetails: {
                subject: VAPID_SUBJECT,
                publicKey: keys.publicKey,
                privateKey: keys.privateKey,
              },
              TTL: 300,
            },
          );
          sent += 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.devices.setPushSubscription(device.id, null);
            return;
          }
          console.warn(
            `[remote-control] push to device ${device.id} failed:`,
            status ?? err,
          );
        }
      }),
    );
    return sent;
  }

  private ensureKeys(): VapidKeys {
    if (this.keys) return this.keys;
    if (!this.loaded) {
      this.loaded = true;
      this.keys = this.read();
    }
    if (this.keys) return this.keys;

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS encryption is unavailable, so the push signing key cannot be " +
          "stored safely. Push stays off.",
      );
    }
    const keys = this.generate();
    const encrypted = safeStorage.encryptString(JSON.stringify(keys));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    fs.chmodSync(this.filePath, 0o600);
    this.keys = keys;
    return keys;
  }

  private read(): VapidKeys | null {
    try {
      const decrypted = safeStorage.decryptString(
        fs.readFileSync(this.filePath),
      );
      const parsed: unknown = JSON.parse(decrypted);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as VapidKeys).publicKey === "string" &&
        typeof (parsed as VapidKeys).privateKey === "string"
      ) {
        return parsed as VapidKeys;
      }
    } catch {
      // No file, or a file this install cannot decrypt. A fresh pair is
      // generated, and phones re-subscribe on their next visit.
    }
    return null;
  }
}

/** The user-visible half of a push. No scrollback, ever. */
export function pushPayloadFor(
  status: PushableStatus,
  agent: { id: string; name: string | null; projectName: string | null },
): PushPayload {
  return {
    agentId: agent.id,
    title: status === "error" ? "Agent errored" : "Agent needs input",
    body: [agent.name || "Agent", agent.projectName].filter(Boolean).join(" — "),
  };
}
