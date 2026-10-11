import { describe, expect, it } from "vitest";
import { httpUrl } from "./http-url";

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
