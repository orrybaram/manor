import { describe, expect, it, vi } from "vitest";
import {
  fetchImageDataUrl,
  ImageAuthError,
  imageContentType,
  MAX_IMAGE_BYTES,
} from "./image-proxy";

const trusted = (url: URL) => url.hostname === "trusted.example";

function response(status: number, headers: Record<string, string>, body = "") {
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

describe("fetchImageDataUrl", () => {
  it("returns the image as a data URL, sending the token to a trusted host", async () => {
    const fetchImpl = vi.fn(async () => response(200, { "content-type": "image/png" }, "png"));
    const url = await fetchImageDataUrl({
      url: "https://trusted.example/a.png",
      authorization: "token t",
      isTrusted: trusted,
      fetchImpl,
    });
    expect(url).toBe(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://trusted.example/a.png",
      expect.objectContaining({ headers: { Authorization: "token t" }, redirect: "manual" }),
    );
  });

  it("never sends the token past a redirect to another host", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, { location: "https://s3.example/signed.png" }))
      .mockResolvedValueOnce(response(200, { "content-type": "image/png" }, "png"));
    await fetchImageDataUrl({
      url: "https://trusted.example/a.png",
      authorization: "token t",
      isTrusted: trusted,
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://s3.example/signed.png");
    expect(fetchImpl.mock.calls[1][1].headers).toEqual({});
  });

  it("refuses a redirect off https", async () => {
    const fetchImpl = vi.fn(async () => response(302, { location: "http://trusted.example/a.png" }));
    await expect(
      fetchImageDataUrl({ url: "https://trusted.example/a.png", authorization: "t", isTrusted: trusted, fetchImpl }),
    ).rejects.toThrow(/non-https/);
  });

  it("flags a 401 from a trusted host as an auth error", async () => {
    const fetchImpl = vi.fn(async () => response(401, {}));
    await expect(
      fetchImageDataUrl({ url: "https://trusted.example/a.png", authorization: "t", isTrusted: trusted, fetchImpl }),
    ).rejects.toBeInstanceOf(ImageAuthError);
  });

  it("refuses an image over the size cap", async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) }, "x"),
    );
    await expect(
      fetchImageDataUrl({ url: "https://trusted.example/a.png", authorization: "t", isTrusted: trusted, fetchImpl }),
    ).rejects.toThrow(/too large/);
  });
});

describe("imageContentType", () => {
  const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  it("keeps an image/* type, dropping parameters", () => {
    expect(imageContentType("image/png; charset=binary", "/a.png", Buffer.alloc(0))).toBe("image/png");
  });

  it("takes raw.githubusercontent.com's text/plain SVG as an SVG", () => {
    expect(imageContentType("text/plain; charset=utf-8", "/acme/app/main/arch.svg", svg)).toBe("image/svg+xml");
  });

  it("refuses anything else", () => {
    expect(() => imageContentType("text/html", "/login", Buffer.from("<html>"))).toThrow(/Not an image/);
    expect(() => imageContentType("text/plain", "/notes.svg", Buffer.from("hello"))).toThrow(/Not an image/);
  });
});
