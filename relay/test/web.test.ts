import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { WEB_CSP } from "../../src/lib/web-headers";

const ORIGIN = "https://relay.test";

beforeAll(async () => {
  await env.WEB.put("app/1.2.3/web.html", "<html>shell</html>");
  await env.WEB.put("app/1.2.3/assets/index-abc123.js", "console.log(1)");
  await env.WEB.put("app/1.2.3/sw.js", "// sw");
  await env.WEB.put("app/1.2.3/fonts/Mono-Regular.ttf", "ttf");
  await env.WEB.put("app/1.2.3/manifest.webmanifest", "{}");
  await env.WEB.put("app/1.2.3+build.7/web.html", "<html>build</html>");
  await env.WEB.put("x", "secret outside the version");
});

describe("GET /app/<version>/*", () => {
  it("serves the shell for the bare version path with CSP and no-store", async () => {
    for (const p of ["/app/1.2.3", "/app/1.2.3/", "/app/1.2.3/web.html"]) {
      const res = await SELF.fetch(ORIGIN + p);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>shell</html>");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("content-security-policy")).toBe(WEB_CSP);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves hashed assets as immutable and sw.js as no-store", async () => {
    const asset = await SELF.fetch(
      `${ORIGIN}/app/1.2.3/assets/index-abc123.js`,
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(asset.headers.get("content-security-policy")).toBe(WEB_CSP);
    const sw = await SELF.fetch(`${ORIGIN}/app/1.2.3/sw.js`);
    expect(sw.headers.get("cache-control")).toBe("no-store");
    await sw.arrayBuffer();
  });

  it("serves fonts with a font content type", async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/1.2.3/fonts/Mono-Regular.ttf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/ttf");
    await res.arrayBuffer();
  });

  it("never caches the manifest, which has a stable name", async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/1.2.3/manifest.webmanifest`);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await res.arrayBuffer();
  });

  it("accepts semver build metadata in the version", async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/1.2.3+build.7/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>build</html>");
    const missing = await SELF.fetch(`${ORIGIN}/app/9.9.9+sha.abc/`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("isn't published");
  });

  it("explains an unpublished version", async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/9.9.9/`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(
      "This Manor version's web app isn't published. Update Manor, or use Tailscale.",
    );
  });

  it("404s a missing file of a published version", async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/1.2.3/assets/nope.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("rejects malformed versions and traversal", async () => {
    const paths = [
      "/app/1.0.0/../x",
      "/app/1.2.3/%2e%2e/x",
      "/app/1.2.3/%2E%2E%2Fx",
      "/app/1.2.3/..%2f..%2fx",
      "/app/1.2.3/assets%5c..%5cx",
      "/app/1.2.3/%00",
      "/app/1.2.3/%zz",
      "/app/..%2fx/web.html",
      "/app/../x",
      "/app/1.2/web.html",
      "/app/latest/web.html",
      "/app/1.2.3%2f..%2f..%2fx",
    ];
    for (const p of paths) {
      const res = await SELF.fetch(ORIGIN + p);
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).not.toContain("secret");
    }
  });
});
