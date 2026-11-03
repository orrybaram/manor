import { describe, expect, it } from "vitest";
import {
  clampDialogText,
  DialogTokens,
  isPaneOrigin,
  MAX_DIALOG_TEXT,
  requestOrigin,
} from "../page-dialog-guard";

describe("requestOrigin", () => {
  it("takes the Origin header first", () => {
    expect(requestOrigin("https://github.com", "https://evil.com/page")).toBe("https://github.com");
  });

  it("falls back to the referrer's origin", () => {
    expect(requestOrigin(null, "http://127.0.0.1:5173/app?x=1")).toBe("http://127.0.0.1:5173");
  });

  it("is null without a tuple origin to go on", () => {
    expect(requestOrigin(null, "")).toBeNull();
    expect(requestOrigin("null", "")).toBeNull();
    expect(requestOrigin(null, "about:client")).toBeNull();
    expect(requestOrigin(null, "data:text/html,hi")).toBeNull();
    expect(requestOrigin(null, "not a url")).toBeNull();
  });
});

describe("isPaneOrigin", () => {
  const frames = ["https://github.com", "https://www.youtube.com"];

  it("accepts the origin of any frame in the pane", () => {
    expect(isPaneOrigin("https://github.com", frames)).toBe(true);
    expect(isPaneOrigin("https://www.youtube.com", frames)).toBe(true);
  });

  it("refuses an origin no frame has", () => {
    expect(isPaneOrigin("https://evil.com", frames)).toBe(false);
    expect(isPaneOrigin("http://github.com", frames)).toBe(false);
    expect(isPaneOrigin("https://github.com", [])).toBe(false);
  });
});

describe("clampDialogText", () => {
  it("leaves short text alone", () => {
    expect(clampDialogText("Delete?")).toBe("Delete?");
  });

  it("cuts long text to the limit", () => {
    const clamped = clampDialogText("x".repeat(MAX_DIALOG_TEXT * 10));
    expect(clamped).toBe(`${"x".repeat(MAX_DIALOG_TEXT)}…`);
  });
});

describe("DialogTokens", () => {
  const minting = () => {
    let n = 0;
    return new DialogTokens<string>(() => `t${++n}`);
  };

  it("resolves a pane's token to it", () => {
    const tokens = minting();
    const a = tokens.issue("pane-a");
    const b = tokens.issue("pane-b");
    expect(tokens.resolve(a)).toBe("pane-a");
    expect(tokens.resolve(b)).toBe("pane-b");
    expect(tokens.resolve("t99")).toBeUndefined();
  });

  it("keeps the old document's token until the new one commits", () => {
    const tokens = minting();
    const first = tokens.issue("pane");
    const next = tokens.issue("pane"); // a navigation starts
    expect(tokens.resolve(first)).toBe("pane");
    tokens.committed("pane");
    expect(tokens.resolve(first)).toBeUndefined();
    expect(tokens.resolve(next)).toBe("pane");
  });

  it("retires every token before the newest on commit", () => {
    const tokens = minting();
    const first = tokens.issue("pane");
    const abandoned = tokens.issue("pane");
    const last = tokens.issue("pane");
    tokens.committed("pane");
    expect(tokens.resolve(first)).toBeUndefined();
    expect(tokens.resolve(abandoned)).toBeUndefined();
    expect(tokens.resolve(last)).toBe("pane");
  });

  it("leaves other panes' tokens alone", () => {
    const tokens = minting();
    const other = tokens.issue("other");
    tokens.issue("pane");
    tokens.issue("pane");
    tokens.committed("pane");
    tokens.release("pane");
    expect(tokens.resolve(other)).toBe("other");
  });

  it("drops all of a released pane's tokens", () => {
    const tokens = minting();
    const first = tokens.issue("pane");
    const next = tokens.issue("pane");
    tokens.release("pane");
    expect(tokens.resolve(first)).toBeUndefined();
    expect(tokens.resolve(next)).toBeUndefined();
  });
});
