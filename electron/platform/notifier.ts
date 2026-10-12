/**
 * The desktop-notification port (ADR-218 D6). Electron shows a native
 * notification; a headless host has nowhere to show one and uses `noopNotifier`.
 */
export interface NotifyOptions {
  title: string;
  body?: string;
  /** Called if the user clicks the notification, where the platform supports it. */
  onClick?: () => void;
}

export interface Notifier {
  notify(opts: NotifyOptions): void;
}

export const noopNotifier: Notifier = { notify: () => {} };
