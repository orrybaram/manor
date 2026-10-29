/**
 * Web Push for remote control.
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
 * store (a `SealedStore`, read once by `init()`). Losing it costs every
 * subscription (phones must re-subscribe), which is why it is persisted rather
 * than regenerated per launch.
 *
 * `web-push` itself is loaded on first real use — a send, or generating the
 * key pair — never at startup. A user with no subscribed phones
 * never loads it at all.
 */

import type * as WebPush from "web-push";

import { cjsExports, lazy } from "../lib/lazy";
import { remoteVapidFile } from "../paths";
import type { SecretBox } from "../platform/secret-box";
import {
  EncryptionUnavailableError,
  SealedStore,
  type SealedCodec,
} from "../platform/sealed-store";
import type { PushSubscriptionRecord, RemoteDeviceStore } from "./devices";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushPayload {
  /** The agent a tap opens; absent on a push about no agent (a run that failed to start). */
  agentId?: string;
  /** The automation it is about, when it is about one. */
  automationId?: string;
  /**
   * With `automationId`: the host keeping it, as a phone knows it — the
   * pushing server's relay room, the id a phone's page gives that server's
   * own host. Absent when the server has no room.
   */
  hostId?: string;
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

/** `web-push`, loaded on first use. */
const loadWebPush = lazy(async () =>
  cjsExports(await import("web-push"), "sendNotification"),
);

export interface PushNotifyOptions {
  /**
   * Subscriptions to leave out: the endpoints a host server already pushes to
   * for its own agents, so a phone paired both ways hears once.
   */
  skipEndpoints?: ReadonlySet<string>;
}

const VAPID_CODEC: SealedCodec<VapidKeys> = {
  parse(text) {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as VapidKeys).publicKey === "string" &&
      typeof (parsed as VapidKeys).privateKey === "string"
    ) {
      const { publicKey, privateKey } = parsed as VapidKeys;
      return { publicKey, privateKey };
    }
    return null;
  },
  serialize: (keys) => JSON.stringify(keys),
};

export class PushManager {
  /**
   * The active key pair once `init()` has read the file: `keys` is null until
   * one is generated or imported. The whole slot is null before `init()`.
   */
  private active: { keys: VapidKeys | null } | null = null;
  /** Reads the file at most once; a read that threw is retried next time. */
  private readonly loadOnce = lazy(async () => {
    this.active = { keys: await this.store.init() };
  });
  /** In-flight generation, so concurrent callers share one key pair. */
  private generating: Promise<VapidKeys> | null = null;
  private readonly store: SealedStore<VapidKeys>;

  constructor(
    private readonly devices: RemoteDeviceStore,
    private readonly secretBox: SecretBox,
    filePath: string = remoteVapidFile(),
    /** Injected so tests do not talk to a real push service. */
    private readonly send: typeof WebPush.sendNotification = async (...args) =>
      (await loadWebPush()).sendNotification(...args),
    private readonly generate: () => VapidKeys | Promise<VapidKeys> = async () =>
      (await loadWebPush()).generateVAPIDKeys(),
  ) {
    this.store = new SealedStore(secretBox, filePath, "push key", VAPID_CODEC);
  }

  /**
   * Decrypt the stored key pair into memory. The app calls it at startup;
   * everything that needs the keys awaits it too, so a caller racing startup
   * waits for the read rather than generating a pair over it. No file, or one this install cannot open, means a fresh pair on
   * first use, and phones re-subscribe on their next visit. A box that could
   * not run at all rejects (`SecretBoxUnavailableError`): push stays off and
   * the file is left alone.
   */
  init(): Promise<void> {
    return this.loadOnce();
  }

  /**
   * The application server key a client needs to subscribe. Generates the pair
   * on first use; returns null if it cannot be stored safely, which disables
   * push rather than leaving a private key in plaintext.
   */
  async publicKey(): Promise<string | null> {
    try {
      return (await this.ensureKeys()).publicKey;
    } catch {
      return null;
    }
  }

  /**
   * The active key pair, generated on first use, for sharing with a host
   * server. Null when it cannot be stored safely.
   */
  async vapidKeys(): Promise<VapidKeys | null> {
    try {
      return await this.ensureKeys();
    } catch {
      return null;
    }
  }

  /**
   * Adopt `keys` as this manager's pair. A browser holds one
   * push subscription per origin, tied to one VAPID key, so every server a
   * phone is paired with signs with the desktop's. When the public key
   * actually changes, the stored subscriptions (made against the old key)
   * are cleared; unchanged keys are a no-op. Returns whether it changed.
   * Throws if the key cannot be stored safely.
   */
  async importKeys(keys: VapidKeys): Promise<boolean> {
    const active = await this.inited();
    if (!this.secretBox.available()) throw new EncryptionUnavailableError();
    // Wait out a generation in flight, then compare with what is active.
    if (this.generating) await this.generating.catch(() => undefined);
    const current = active.keys;
    if (
      current &&
      current.publicKey === keys.publicKey &&
      current.privateKey === keys.privateKey
    ) {
      return false;
    }
    const next = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    this.store.write(next);
    await this.store.flush();
    active.keys = next;
    if (!current || current.publicKey !== next.publicKey) {
      this.devices.clearPushSubscriptions();
    }
    return true;
  }

  /**
   * Replace the key pair with a freshly generated one and clear every
   * subscription made against the old one (a cloned host must not
   * keep signing with its origin's key). Throws if the key cannot be stored
   * safely.
   */
  async reset(): Promise<void> {
    const active = await this.inited();
    if (!this.secretBox.available()) throw new EncryptionUnavailableError();
    if (this.generating) await this.generating.catch(() => undefined);
    await this.generateAndStore(active);
    this.devices.clearPushSubscriptions();
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
  async notify(
    payload: PushPayload,
    opts: PushNotifyOptions = {},
  ): Promise<number> {
    // Before anything else: with nothing subscribed there is nothing to sign,
    // so neither the key nor `web-push` is needed.
    const skip = opts.skipEndpoints;
    const targets = this.devices
      .pushTargets()
      .filter(({ subscription }) => !skip?.has(subscription.endpoint));
    if (targets.length === 0) return 0;

    let keys: VapidKeys;
    try {
      keys = await this.ensureKeys();
    } catch {
      return 0;
    }

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
            try {
              this.devices.setPushSubscription(device.id, null);
            } catch (persistErr) {
              // Dropped from memory either way; the store reports its own
              // write failure to the next pair or revoke.
              console.warn(
                `[remote-control] could not drop retired push endpoint for ${device.id}:`,
                persistErr,
              );
            }
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

  private async ensureKeys(): Promise<VapidKeys> {
    const active = await this.inited();
    if (active.keys) return active.keys;

    if (!this.secretBox.available()) {
      throw new Error(
        "OS encryption is unavailable, so the push signing key cannot be " +
          "stored safely. Push stays off.",
      );
    }
    if (!this.generating) {
      this.generating = this.generateAndStore(active).finally(() => {
        this.generating = null;
      });
    }
    return this.generating;
  }

  private async generateAndStore(active: {
    keys: VapidKeys | null;
  }): Promise<VapidKeys> {
    const keys = await this.generate();
    this.store.write(keys);
    await this.store.flush();
    active.keys = keys;
    return keys;
  }

  private async inited(): Promise<{ keys: VapidKeys | null }> {
    await this.init();
    return this.active!;
  }
}

/** What a push needs to know of an agent: never its scrollback. */
export interface PushAgent {
  id: string;
  name: string | null;
  projectName: string | null;
  /** The automation whose run started it, which titles the push. */
  automationName?: string | null;
}

/** The user-visible half of a push. No scrollback, ever. */
export function pushPayloadFor(status: PushableStatus, agent: PushAgent): PushPayload {
  const who = agent.automationName || "Agent";
  return {
    agentId: agent.id,
    title: status === "error" ? `${who} errored` : `${who} needs input`,
    body: [agent.name || "Agent", agent.projectName]
      .filter(Boolean)
      .join(" — "),
  };
}

/**
 * A run that could not start its agent, as a push: nothing else would tell
 * anyone, since there is no agent to need input. The detail is the run's
 * own message ("The project isn't set up on this host"), never a terminal's.
 */
export function automationFailedPayload(
  automation: { id: string; name: string },
  run: { detail?: string },
  roomId?: string | null,
): PushPayload {
  return {
    automationId: automation.id,
    ...(roomId ? { hostId: roomId } : {}),
    title: `${automation.name} failed to start`,
    body: run.detail ?? "The run could not start its agent",
  };
}

/**
 * A recorded run, as a push to every subscribed device when it failed to
 * start; nothing for one that started (its agent pushes for itself) or was
 * skipped (the run history has it).
 */
export function pushAutomationRun(
  push: Pick<PushManager, "notify">,
  automation: { id: string; name: string },
  run: { outcome: string; detail?: string },
  /** The pushing server's relay room, which names its host to a phone. */
  roomId: string | null,
  opts?: PushNotifyOptions,
): void {
  if (run.outcome !== "failed") return;
  void push.notify(automationFailedPayload(automation, run, roomId), opts);
}

/**
 * One agent-status transition, as a push to every subscribed device — or
 * nothing, when the status is not worth waking a phone for or did not change.
 * The one rule for both the desktop's controller and a host server
 * each of which hands it transitions already coalesced across a
 * hook replay (`NotificationCoalescer`).
 */
export function pushAgentTransition(
  push: Pick<PushManager, "notify">,
  agent: PushAgent,
  previousStatus: string | null | undefined,
  status: string,
  opts?: PushNotifyOptions,
): void {
  if (!isPushable(status) || status === previousStatus) return;
  void push.notify(pushPayloadFor(status, agent), opts);
}

/**
 * Validate a subscription body. `endpoint` must be https — a push endpoint is a
 * capability URL, and we will not store one that would be sent in the clear.
 * Used by the bridge's `remoteControl.subscribePush`.
 */
export function asPushSubscription(
  body: unknown,
): PushSubscriptionRecord | null {
  if (typeof body !== "object" || body === null) return null;
  const { endpoint, keys } = body as Record<string, unknown>;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://"))
    return null;
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || p256dh.length === 0) return null;
  if (typeof auth !== "string" || auth.length === 0) return null;
  return { endpoint, keys: { p256dh, auth } };
}
