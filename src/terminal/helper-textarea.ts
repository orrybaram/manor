/**
 * The attributes xterm's hidden `.xterm-helper-textarea` must carry for a
 * phone's soft keyboard to type into a terminal (ADR-181 D6).
 *
 * xterm takes every keystroke through that one textarea, and a soft keyboard
 * treats it like any other text field unless told otherwise: it capitalises
 * the first letter (`Ls`), "corrects" command names and flags, underlines
 * them as misspellings, and offers to autofill them. Each of those rewrites
 * the bytes that reach the pty, so a terminal that allows any of them is
 * broken.
 *
 * xterm 6 already sets the first three itself; they are set again here so the
 * guarantee is this app's rather than a detail of the xterm version it
 * happens to ship, and `autocomplete` — which xterm does not set — is added.
 */
export const HELPER_TEXTAREA_ATTRIBUTES: Readonly<Record<string, string>> = {
  autocapitalize: "off",
  autocorrect: "off",
  autocomplete: "off",
  spellcheck: "false",
};

/** Apply `HELPER_TEXTAREA_ATTRIBUTES` to a terminal's textarea, if it has one. */
export function configureHelperTextarea(
  textarea: HTMLTextAreaElement | undefined | null,
): void {
  if (!textarea) return;
  for (const [name, value] of Object.entries(HELPER_TEXTAREA_ATTRIBUTES)) {
    textarea.setAttribute(name, value);
  }
}
