/**
 * How a browser pane names the site at `url`: its `host:port`. A remote
 * pane's forwarded URL is named by the box's own address instead, which
 * `BrowserPane` looks up (`ports.remoteUrl`) and passes here.
 */
export function siteLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
