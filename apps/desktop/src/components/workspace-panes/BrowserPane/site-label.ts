import { isLocalhostHttpUrl } from "../../../lib/hosts";

/**
 * How a browser pane names the site at `url`: its `host:port`. A remote
 * pane's page is served through a port forward on this machine, so a
 * loopback URL is named by the box's own address the pane remembers
 * (`remembered`), not the forward's.
 */
export function siteLabel(url: string, remembered: string | null): string {
  const source =
    remembered && isLocalhostHttpUrl(url) && isLocalhostHttpUrl(remembered) ? remembered : url;
  try {
    return new URL(source).host || source;
  } catch {
    return source;
  }
}
