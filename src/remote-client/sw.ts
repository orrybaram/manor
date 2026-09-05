/// <reference lib="webworker" />

/**
 * Service worker for the ADR-161 phone client.
 *
 * Exists only to receive Web Push and to focus the right session when a
 * notification is tapped. It caches nothing: an offline copy of a session list
 * would be both stale and a place for session data to sit on disk, and the
 * page is a few kilobytes over a tunnel anyway.
 *
 * The payload never contains scrollback — see `electron/remote-control/push.ts`
 * — so nothing sensitive reaches the notification shade.
 */

declare const self: ServiceWorkerGlobalScope;

interface PushPayload {
  agentId: string;
  title: string;
  body: string;
}

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload: PushPayload;
  try {
    payload = event.data?.json() as PushPayload;
  } catch {
    return;
  }
  if (!payload?.title) return;

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // One notification per session: a session that flaps between blocked and
      // working must not stack up a column of them.
      tag: `manor-${payload.agentId}`,
      renotify: true,
      data: { agentId: payload.agentId },
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const agentId = (event.notification.data as { agentId?: string } | null)
    ?.agentId;

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) {
        if ("focus" in client) {
          if (agentId) client.postMessage({ type: "open-agent", agentId });
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(
        agentId ? `./?agent=${encodeURIComponent(agentId)}` : "./",
      );
    })(),
  );
});

export {};
