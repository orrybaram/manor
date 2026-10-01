/// <reference lib="webworker" />

/**
 * Service worker for the web app (ADR-206 D7): receives Web Push and focuses
 * or opens the app when a notification is tapped. Caches nothing. Built to
 * `sw.js` under the web base (`vite.web.config.ts`) and registered with
 * scope = that base, so a per-version relay path (ADR-206 D5) owns its own.
 *
 * The payload carries a label and a project name, never scrollback.
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
  let payload: PushPayload | undefined;
  try {
    payload = event.data?.json() as PushPayload | undefined;
  } catch {
    return;
  }
  if (!payload?.title) return;

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
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
      // The registration scope is the base this worker was built for (a
      // version path under the relay), so this never opens `/`.
      await self.clients.openWindow(self.registration.scope);
    })(),
  );
});

export {};
