import { describe, expect, it, vi } from "vitest";

async function freshModule() {
  vi.resetModules();
  return import("../syntax");
}

describe("extToLang", () => {
  it("maps a file's extension to its grammar", async () => {
    const { extToLang } = await freshModule();
    expect(extToLang("src/App.tsx")).toBe("tsx");
    expect(extToLang("README.MD")).toBe("markdown");
    expect(extToLang("Makefile")).toBeNull();
  });
});

describe("loadTokenizer", () => {
  it("has no highlighter until one is loaded", async () => {
    const { loadedTokenizer } = await freshModule();
    expect(loadedTokenizer()).toBeNull();
  });

  it("loads a highlighter that tokenizes known grammars", async () => {
    const { loadTokenizer, loadedTokenizer } = await freshModule();

    const tokenize = await loadTokenizer();
    const nodes = tokenize("const x = 1;", "typescript");

    expect(loadedTokenizer()).toBe(tokenize);
    expect(nodes.some((n) => n.type === "element")).toBe(true);
  });

  it("returns plain text for a grammar it does not know", async () => {
    const { loadTokenizer } = await freshModule();
    const tokenize = await loadTokenizer();

    expect(tokenize("x", "cobol")).toEqual([{ type: "text", value: "x" }]);
  });

  it("starts the load when a diff subscribes, and tells it when it lands", async () => {
    const { subscribeTokenizer, loadTokenizer, loadedTokenizer } =
      await freshModule();
    const onLoad = vi.fn();

    const unsubscribe = subscribeTokenizer(onLoad);
    const tokenize = await loadTokenizer();

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(loadedTokenizer()).toBe(tokenize);
    unsubscribe();
  });

  it("shares one load between callers", async () => {
    const { loadTokenizer } = await freshModule();
    expect(loadTokenizer()).toBe(loadTokenizer());
  });
});
