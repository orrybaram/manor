/**
 * Browser side of Web Push for the web app (ADR-206 D7): registers the
 * service worker at the current base, subscribes with the host's VAPID key
 * and hands the subscription to the machine over the bridge.
 */

export type PushState = "hidden" | "offer" | "needs-install" | "denied" | "on";

function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

function supported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** What the control should offer right now. Only a device (web app) sees one. */
export function currentPushState(): PushState {
  if (window.electronAPI?.platform !== "web") return "hidden";
  if (!supported())
    return isIos() && !isStandalone() ? "needs-install" : "hidden";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted") return "on";
  return "offer";
}

/**
 * The "Enable notifications" tap. Must be called synchronously from the tap
 * handler: when permission is still undecided it asks *first*, before any
 * `await`, because WebKit resolves `requestPermission()` to `"denied"`
 * without a recent user activation — and asking again when the answer is
 * already in would spend that activation for nothing (WebKit consumes it
 * before looking at the stored answer). Then it subscribes, as on mount.
 */
export async function enablePush(): Promise<PushState> {
  const asked =
    Notification.permission === "default"
      ? Notification.requestPermission()
      : Promise.resolve(Notification.permission);
  const permission = await asked;
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "offer";
  }
  return subscribeAndSend();
}

/**
 * On mount, with no gesture: never asks. If permission was granted on an
 * earlier visit, re-sends the subscription quietly so a host that lost it
 * (or a new relay pairing, or a new version scope) is kept current;
 * otherwise reports what the control should offer.
 */
export async function resubscribePush(): Promise<PushState> {
  if (currentPushState() !== "on") return currentPushState();
  return subscribeAndSend();
}

async function subscribeAndSend(): Promise<PushState> {
  const api = window.electronAPI.remoteControl;
  const key = await api.vapidPublicKey();
  if (!key) return "hidden";
  const serverKey = decodeKey(key);
  const base = import.meta.env.BASE_URL;
  const registration = await activated(
    await navigator.serviceWorker.register(`${base}sw.js`, { scope: base }),
  );
  let subscription = await registration.pushManager.getSubscription();
  // One `/app/<version>/` registration serves every desktop on that version
  // at the relay origin, so the existing subscription may be bound to
  // another desktop's VAPID key (or this one's before it was regenerated):
  // pushes signed with ours would be refused. Replace it.
  if (
    subscription &&
    !sameKey(subscription.options.applicationServerKey, serverKey)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey,
  });
  await api.subscribePush(subscription.toJSON());
  return "on";
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (current === null) return false;
  const bytes = new Uint8Array(current);
  return (
    bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i])
  );
}

/**
 * `registration` once it has an active worker: `pushManager.subscribe()`
 * rejects on a registration whose worker is still installing (a first visit,
 * or the first load of a new version's scope). Not
 * `navigator.serviceWorker.ready`: that waits for a registration whose scope
 * covers the *page*, and `/app` (no slash) is outside the `/app/` scope, so
 * it would never settle there.
 */
function activated(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorkerRegistration> {
  if (registration.active) return Promise.resolve(registration);
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return Promise.reject(new Error("no service worker"));
  return new Promise((resolve, reject) => {
    const onState = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onState);
        resolve(registration);
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onState);
        reject(new Error("service worker failed to install"));
      }
    };
    worker.addEventListener("statechange", onState);
    onState();
  });
}
