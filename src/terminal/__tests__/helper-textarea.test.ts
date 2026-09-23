// @vitest-environment jsdom
/**
 * ADR-181 D6: a phone's soft keyboard types straight into xterm's hidden
 * textarea, so that textarea must never let the keyboard rewrite what is
 * typed — `ls` capitalised to `Ls` is a broken terminal.
 */
import { describe, expect, it } from "vitest";
import {
  HELPER_TEXTAREA_ATTRIBUTES,
  configureHelperTextarea,
} from "../helper-textarea";

describe("configureHelperTextarea", () => {
  it("turns off capitalisation, correction, spellcheck and autofill", () => {
    const textarea = document.createElement("textarea");
    configureHelperTextarea(textarea);
    expect(textarea.getAttribute("autocapitalize")).toBe("off");
    expect(textarea.getAttribute("autocorrect")).toBe("off");
    expect(textarea.getAttribute("spellcheck")).toBe("false");
    expect(textarea.getAttribute("autocomplete")).toBe("off");
  });

  it("overrides whatever the textarea carried before", () => {
    const textarea = document.createElement("textarea");
    textarea.setAttribute("autocapitalize", "sentences");
    textarea.setAttribute("spellcheck", "true");
    configureHelperTextarea(textarea);
    for (const [name, value] of Object.entries(HELPER_TEXTAREA_ATTRIBUTES)) {
      expect(textarea.getAttribute(name)).toBe(value);
    }
  });

  it("tolerates a terminal that has not been opened yet", () => {
    expect(() => configureHelperTextarea(undefined)).not.toThrow();
  });
});
