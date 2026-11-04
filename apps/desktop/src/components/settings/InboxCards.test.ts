import { describe, expect, it } from "vitest";

import { inboxStatusLine } from "./InboxCards";

const source = { unit: "repo", signedOut: "SIGNED OUT", refused: "REFUSED", none: "NONE" };
const now = Date.parse("2026-11-04T12:00:00Z");
const checkedAt = "2026-11-04T11:58:00Z";

describe("inboxStatusLine", () => {
  it("says how a working source stands", () => {
    expect(inboxStatusLine(source, { state: "ok", account: "me", covered: 2, checkedAt }, now)).toEqual({
      text: "me · 2 repos from your projects · checked 2 min ago",
      warn: false,
    });
  });

  it("uses the singular, and leaves out an account it doesn't have", () => {
    expect(inboxStatusLine(source, { state: "ok", account: null, covered: 1, checkedAt }, now).text).toBe(
      "1 repo from your projects · checked 2 min ago",
    );
  });

  it("warns when no project is covered", () => {
    expect(inboxStatusLine(source, { state: "ok", account: "me", covered: 0, checkedAt }, now)).toEqual({
      text: "NONE",
      warn: true,
    });
  });

  it("warns when signed out", () => {
    expect(inboxStatusLine(source, { state: "signed-out" }, now)).toEqual({ text: "SIGNED OUT", warn: true });
  });

  it("names a refused sign-in as something to fix", () => {
    const status = { state: "error" as const, message: "GitHub answered 401", checkedAt: null };
    expect(inboxStatusLine(source, status, now)).toEqual({ text: "REFUSED", warn: true });
  });

  it("calls anything else temporary", () => {
    const status = { state: "error" as const, message: "GitHub answered 403", checkedAt };
    expect(inboxStatusLine(source, status, now)).toEqual({
      text: "Couldn't check. Trying again soon. Last worked 2 min ago.",
      warn: true,
    });
  });

  it("is neutral before the first check", () => {
    expect(inboxStatusLine(source, { state: "starting" }, now).warn).toBe(false);
  });
});
