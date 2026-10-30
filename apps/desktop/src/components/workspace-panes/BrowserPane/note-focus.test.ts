// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { typingElsewhere } from "./note-placement";

describe("typingElsewhere", () => {
  document.body.innerHTML = `
    <div data-pane-id="term"><textarea id="xterm"></textarea></div>
    <div data-pane-id="browser"><webview id="page"></webview><div id="popover"><input id="note"></div></div>
    <button id="button"></button>`;
  const el = (id: string) => document.getElementById(id);

  it("leaves a terminal or another field its keys", () => {
    expect(typingElsewhere(el("xterm"), el("popover"))).toBe(true);
  });

  it("takes focus from the page, the body, or a button", () => {
    expect(typingElsewhere(el("page"), el("popover"))).toBe(false);
    expect(typingElsewhere(document.body, el("popover"))).toBe(false);
    expect(typingElsewhere(el("button"), el("popover"))).toBe(false);
    expect(typingElsewhere(null, el("popover"))).toBe(false);
  });
});
