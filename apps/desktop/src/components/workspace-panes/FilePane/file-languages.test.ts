import { describe, it, expect } from "vitest";
import { languageFor, loadLanguage } from "./file-languages";

describe("languageFor", () => {
  it("maps the languages the pane highlights by extension", () => {
    expect(languageFor("src/a.ts")).toBe("typescript");
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("scripts/build.mjs")).toBe("javascript");
    expect(languageFor("src/Button.jsx")).toBe("jsx");
    expect(languageFor("package.json")).toBe("json");
    expect(languageFor("src/App.module.css")).toBe("css");
    expect(languageFor("index.html")).toBe("html");
    expect(languageFor("docs/README.md")).toBe("markdown");
    expect(languageFor("tool/main.py")).toBe("python");
    expect(languageFor(".github/workflows/ci.yml")).toBe("yaml");
    expect(languageFor("crates/core/src/lib.rs")).toBe("rust");
    expect(languageFor("cmd/server/main.go")).toBe("go");
  });

  it("ignores case", () => {
    expect(languageFor("NOTES.MD")).toBe("markdown");
    expect(languageFor("Config.YAML")).toBe("yaml");
  });

  it("is plain text for anything else", () => {
    expect(languageFor("Makefile")).toBeNull();
    expect(languageFor(".gitignore")).toBeNull();
    expect(languageFor("bin/manor")).toBeNull();
    expect(languageFor("photo.png")).toBeNull();
    // A dot in a folder name is not an extension.
    expect(languageFor("v1.2/LICENSE")).toBeNull();
  });
});

describe("loadLanguage", () => {
  it("loads a pack on demand", async () => {
    await expect(loadLanguage("json")).resolves.toBeTruthy();
  });
});
