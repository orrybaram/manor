import { afterEach, describe, expect, it } from "vitest";
import { forgetDevTools, rememberDevTools, rememberedDevTools } from "./remembered-devtools";

const RIGHT = { side: "right" as const, fractions: { bottom: 0.4, right: 0.55 } };

afterEach(() => {
  for (const id of ["a", "b"]) forgetDevTools(id);
});

describe("remembered DevTools", () => {
  it("knows nothing of a pane that never had them open", () => {
    expect(rememberedDevTools("a")).toBeUndefined();
  });

  it("keeps a pane's side and sizes for its next mount", () => {
    rememberDevTools("a", RIGHT);
    expect(rememberedDevTools("a")).toEqual(RIGHT);
    expect(rememberedDevTools("b")).toBeUndefined();
  });

  it("keeps the latest side and sizes", () => {
    rememberDevTools("a", RIGHT);
    rememberDevTools("a", { side: "bottom", fractions: { bottom: 0.3, right: 0.55 } });
    expect(rememberedDevTools("a")).toEqual({ side: "bottom", fractions: { bottom: 0.3, right: 0.55 } });
  });

  it("is a copy: changing what was passed in or handed out changes nothing", () => {
    const dock = { side: "right" as const, fractions: { bottom: 0.4, right: 0.55 } };
    rememberDevTools("a", dock);
    dock.fractions.right = 0.9;
    rememberedDevTools("a")!.fractions.bottom = 0.1;
    expect(rememberedDevTools("a")).toEqual(RIGHT);
  });

  it("forgets a pane whose DevTools or pane were closed, so a reused id starts without them", () => {
    rememberDevTools("a", RIGHT);
    rememberDevTools("b", RIGHT);
    forgetDevTools("a");
    expect(rememberedDevTools("a")).toBeUndefined();
    expect(rememberedDevTools("b")).toEqual(RIGHT);
    forgetDevTools("a"); // twice is fine
  });
});
