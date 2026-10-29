import { useSyncExternalStore } from "react";
import type { PushProgressEvent } from "../../../../electron.d";
import { categorizePushError } from "../../../../lib/push-error";
import { ipcErrorMessage } from "../../../../lib/ipc-error";
import { toast, type ProgressHandle } from "../../../../toast";

/** One push in flight: its toast, its elapsed ticker, and whether Cancel was clicked. */
type Push = {
  toast: ProgressHandle;
  timer: ReturnType<typeof setInterval>;
  cancelled: boolean;
};

/**
 * Each workspace's push in flight, by push id (its path). Module-level, as is
 * the progress subscription, so the toast settles however many panes that
 * show a Push button mount, remount or close while it runs.
 */
const pushes = new Map<string, Push>();
const listeners = new Set<() => void>();
let unsubscribeProgress: (() => void) | null = null;

function changed(): void {
  for (const listener of listeners) listener();
}

function settle(pushId: string): Push | undefined {
  const push = pushes.get(pushId);
  if (!push) return undefined;
  clearInterval(push.timer);
  pushes.delete(pushId);
  if (pushes.size === 0) {
    unsubscribeProgress?.();
    unsubscribeProgress = null;
  }
  changed();
  return push;
}

function onProgress(evt: PushProgressEvent): void {
  const push = pushes.get(evt.pushId);
  if (!push) return;

  if (evt.type === "line") {
    // Only the latest line is shown while loading; the full log comes with `done`.
    push.toast.update({ detail: evt.line });
    return;
  }

  settle(evt.pushId);
  if (evt.exitCode === 0) {
    push.toast.succeed("Pushed", { duration: 3000 });
    return;
  }
  // Told by the Cancel click rather than the exit code, which a SIGTERM
  // leaves differently per platform.
  if (push.cancelled) {
    push.toast.fail("Push cancelled", undefined, { duration: 3000 });
    return;
  }
  const pushError = categorizePushError(evt.stderr);
  const stderr = evt.stderr.trim();
  push.toast.fail(pushError.message, undefined, {
    detail: stderr.length > 0 ? stderr : undefined,
    duration: "sticky",
    autoExpand: true,
    action:
      pushError.action?.kind === "set-upstream"
        ? {
            label: pushError.action.label,
            onClick: () => void startPush(evt.pushId, { setUpstream: true }),
          }
        : undefined,
    // Pull-and-retry has no IPC `pull` to call yet, so it gets no button.
  });
}

/**
 * Push the workspace at `wsPath`, on whichever host it lives, with a toast
 * that counts the seconds, shows git's latest line, offers Cancel, and
 * settles as Pushed or as what went wrong (with Set upstream when that is
 * the fix). One push per workspace: a second while one runs does nothing.
 */
export async function startPush(
  wsPath: string,
  opts: { setUpstream?: boolean } = {},
): Promise<void> {
  const pushId = wsPath;
  // Already running here: leave its toast to settle it.
  if (pushes.has(pushId)) return;
  // Shown before awaiting `start`, so there is feedback before the first line.
  const startedAt = Date.now();
  const pushToast = toast.progress("Pushing… 0s", {
    id: pushId,
    duration: "sticky",
    action: {
      label: "Cancel",
      onClick: () => {
        const push = pushes.get(pushId);
        if (push) push.cancelled = true;
        void window.electronAPI.git.push.cancel(pushId);
      },
    },
  });
  pushes.set(pushId, {
    toast: pushToast,
    cancelled: false,
    timer: setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      pushToast.update({ message: `Pushing… ${elapsed}s` });
    }, 1000),
  });
  unsubscribeProgress ??= window.electronAPI.git.push.onProgress(onProgress);
  changed();

  try {
    await window.electronAPI.git.push.start({
      wsPath,
      setUpstream: opts.setUpstream,
    });
  } catch (err) {
    // Refused up front (e.g. one already running): no `done` will come.
    settle(pushId);
    pushToast.fail(ipcErrorMessage(err), undefined, { duration: "sticky" });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the workspace at `wsPath` has a push in flight. */
export function usePushing(wsPath: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () =>
    wsPath ? pushes.has(wsPath) : false,
  );
}
