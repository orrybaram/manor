/// <reference lib="webworker" />

/**
 * Service worker for the web app: receives Web Push and focuses
 * or opens the app when a notification is tapped. Caches nothing. Built to
 * `sw.js` under the web base (`vite.web.config.ts`) and registered with
 * scope = that base, so a per-version relay path owns its own.
 *
 * The payload carries a label and a project name, never scrollback.
 */

import { pushClickMessage, type PushClickData } from "./push-click";

declare const self: ServiceWorkerGlobalScope;

interface PushPayload extends PushClickData {
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
      tag: payload.agentId
        ? `manor-${payload.agentId}`
        : `manor-automation-${payload.automationId ?? "unknown"}`,
      renotify: true,
      data: {
        agentId: payload.agentId,
        automationId: payload.automationId,
        hostId: payload.hostId,
      } satisfies PushClickData,
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // An agent's push opens its agent; a run that failed to start, its
  // automation.
  const message = pushClickMessage(event.notification.data);

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) {
        if ("focus" in client) {
          if (message) client.postMessage(message);
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
