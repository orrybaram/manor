import { describe, expect, it } from "vitest";
import { httpUrl, parseHttpUrl, parseHttpsUrl } from "./http-url";

describe("httpUrl", () => {
  const issue = "https://github.com/acme/app/issues/12";

  it("keeps an absolute http(s) URL", () => {
    expect(httpUrl("https://example.com/a", issue)).toBe("https://example.com/a");
  });

  it("resolves a repo-relative link against the task's URL", () => {
    expect(httpUrl("../blob/main/SPEC.md", issue)).toBe(
      "https://github.com/acme/app/blob/main/SPEC.md",
    );
  });

  it("refuses other schemes and unresolvable relatives", () => {
    expect(httpUrl("javascript:alert(1)", issue)).toBeNull();
    expect(httpUrl("mailto:a@b.c", issue)).toBeNull();
    expect(httpUrl("../SPEC.md")).toBeNull();
  });
});

describe("parseHttpUrl", () => {
  it("parses http and https URLs", () => {
    expect(parseHttpUrl("http://localhost:3000/a")?.port).toBe("3000");
    expect(parseHttpUrl("https://example.com/a")?.hostname).toBe("example.com");
  });

  it("refuses other schemes and garbage", () => {
    expect(parseHttpUrl("file:///etc/passwd")).toBeNull();
    expect(parseHttpUrl("not a url")).toBeNull();
  });
});

describe("parseHttpsUrl", () => {
  it("takes https only", () => {
    expect(parseHttpsUrl("https://example.com/a")?.href).toBe("https://example.com/a");
    expect(parseHttpsUrl("http://example.com/a")).toBeNull();
    expect(parseHttpsUrl("not a url")).toBeNull();
  });
});
