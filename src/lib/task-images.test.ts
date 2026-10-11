import { describe, expect, it } from "vitest";
import {
  githubImageFetchUrl,
  isLinearImageUrl,
  isTrackerImageUrl,
} from "./task-images";

describe("githubImageFetchUrl", () => {
  it("rewrites a repo file link to raw.githubusercontent.com", () => {
    expect(
      githubImageFetchUrl(
        "https://github.com/acme/app/blob/22dd556/ui-feedback/11-17-32.png?raw=true",
      ),
    ).toBe("https://raw.githubusercontent.com/acme/app/22dd556/ui-feedback/11-17-32.png");
    expect(githubImageFetchUrl("https://github.com/acme/app/raw/main/a.png")).toBe(
      "https://raw.githubusercontent.com/acme/app/main/a.png",
    );
  });

  it("keeps GitHub's own upload URLs as they are", () => {
    const upload = "https://github.com/user-attachments/assets/0f1e-2d3c";
    expect(githubImageFetchUrl(upload)).toBe(upload);
    const raw = "https://raw.githubusercontent.com/acme/app/main/a.png";
    expect(githubImageFetchUrl(raw)).toBe(raw);
  });

  it("refuses anything that isn't GitHub over https", () => {
    expect(githubImageFetchUrl("https://example.com/a.png")).toBeNull();
    expect(githubImageFetchUrl("https://github.com.evil.io/a.png")).toBeNull();
    expect(githubImageFetchUrl("http://github.com/acme/app/raw/main/a.png")).toBeNull();
    expect(githubImageFetchUrl("not a url")).toBeNull();
  });
});

describe("isLinearImageUrl", () => {
  it("takes Linear's upload host over https only", () => {
    expect(isLinearImageUrl("https://uploads.linear.app/a/b.png")).toBe(true);
    expect(isLinearImageUrl("http://uploads.linear.app/a/b.png")).toBe(false);
    expect(isLinearImageUrl("https://attacker.example/p.png")).toBe(false);
    expect(isLinearImageUrl("https://uploads.linear.app.evil.io/p.png")).toBe(false);
    expect(isLinearImageUrl("not a url")).toBe(false);
  });
});

describe("isTrackerImageUrl", () => {
  it("routes each provider's own hosts to its proxy", () => {
    expect(isTrackerImageUrl("github", "https://github.com/user-attachments/assets/x")).toBe(true);
    expect(isTrackerImageUrl("github", "https://uploads.linear.app/a.png")).toBe(false);
    expect(isTrackerImageUrl("linear", "https://uploads.linear.app/a.png")).toBe(true);
    expect(isTrackerImageUrl("linear", "https://github.com/user-attachments/assets/x")).toBe(false);
    expect(isTrackerImageUrl("github", "https://i.imgur.com/a.png")).toBe(false);
  });
});
