/**
 * What the remote-control modules need to know about the running app
 * (ADR-218 D6), so they need not import Electron's `app`.
 */
export interface AppInfo {
  version: string;
  isPackaged: boolean;
  logsDir: string;
}
