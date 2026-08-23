/**
 * The client shell is the only thing served before authentication, so the
 * containment check gets a direct test rather than relying on `fetch` (which
 * normalises `..` out of a URL before it ever reaches the server, and would
 * make a broken guard look fine).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { serveClientAsset } from "../static";

/** Captures what a `ServerResponse` would have been given. */
function fakeRes() {
  const written: Array<{ status: number; headers: Record<string, string> }> =
    [];
  let body: Buffer | string | null = null;
  return {
    written,
    get body() {
      return body;
    },
    res: {
      writeHead: (status: number, headers: Record<string, string>) => {
        written.push({ status, headers });
      },
      end: (chunk?: Buffer | string) => {
        body = chunk ?? null;
      },
    },
  };
}

describe("serveClientAsset", () => {
  let dir: string;
  let outside: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-static-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<title>Manor</title>");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "export {};");
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "manor-secret-"));
    fs.writeFileSync(path.join(outside, "token.enc"), "SECRET");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const serve = (pathname: string, root: string | null = dir) => {
    const f = fakeRes();
    const handled = serveClientAsset(
      f.res as unknown as import("node:http").ServerResponse,
      pathname,
      root,
    );
    return { handled, ...f };
  };

  it("serves the shell at /", () => {
    const r = serve("/");
    expect(r.handled).toBe(true);
    expect(r.written[0].status).toBe(200);
    expect(String(r.body)).toContain("Manor");
  });

  it("serves a nested asset with the right content type", () => {
    const r = serve("/assets/app.js");
    expect(r.handled).toBe(true);
    expect(r.written[0].headers["Content-Type"]).toContain("text/javascript");
  });

  it("refuses a traversal that escapes the client directory", () => {
    const escape = `/../${path.basename(outside)}/token.enc`;
    const r = serve(escape);
    expect(r.handled).toBe(false);
    expect(r.body).toBeNull();
  });

  it("refuses an absolute path", () => {
    const r = serve(`/${path.join(outside, "token.enc")}`);
    expect(r.handled).toBe(false);
  });

  it("refuses a directory", () => {
    expect(serve("/assets").handled).toBe(false);
  });

  it("falls through for a path that is not a file", () => {
    expect(serve("/tasks").handled).toBe(false);
    expect(serve("/sessions/send").handled).toBe(false);
  });

  it("serves nothing when there is no client directory", () => {
    expect(serve("/", null).handled).toBe(false);
  });

  it("never caches the shell, always caches hashed assets", () => {
    expect(serve("/").written[0].headers["Cache-Control"]).toBe("no-store");
    expect(
      serve("/assets/app.js").written[0].headers["Cache-Control"],
    ).toContain("immutable");
  });
});
