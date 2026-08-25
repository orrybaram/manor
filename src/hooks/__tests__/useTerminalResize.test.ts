/**
 * `shouldSendFit`'s contract: a measurement is judged against the last size
 * *sent*, and the grid is never consulted.
 *
 * That is the whole of the renderer's half of ADR-165. After ADR-164 the grid
 * is driven by the daemon, so it cannot also be the evidence for what the
 * daemon knows — and when the two have drifted apart, a request for the size
 * the pty should already have is the only thing that puts them back. Deciding
 * from the grid suppresses exactly that request, at exactly the moment it is
 * needed, and the pane then wraps at a different width than the program does
 * for the rest of the session.
 */

import { describe, expect, it } from "vitest";
import { shouldSendFit } from "../useTerminalResize";

describe("shouldSendFit", () => {
  it("sends when nothing has been sent yet", () => {
    expect(shouldSendFit({ cols: 100, rows: 30 }, null)).toBe(true);
  });

  it("does not send the size it last sent", () => {
    expect(shouldSendFit({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(
      false,
    );
  });

  it.each([
    ["a new width", { cols: 120, rows: 30 }],
    ["a new height", { cols: 100, rows: 40 }],
    ["both", { cols: 120, rows: 40 }],
  ])("sends on %s", (_label, proposed) => {
    expect(shouldSendFit(proposed, { cols: 100, rows: 30 })).toBe(true);
  });

  /**
   * The one that matters. A grid sitting at a size the pty does not have must
   * not change the answer either way — it is not evidence, and treating it as
   * evidence is what made the disagreement permanent.
   */
  it("ignores the grid entirely", () => {
    const lastSent = { cols: 100, rows: 30 };
    // The pane still measures what was already sent: nothing to do, however
    // far the grid has drifted.
    expect(shouldSendFit({ cols: 100, rows: 30 }, lastSent)).toBe(false);
    // The pane measures something new: send it, even though a drifted grid
    // would once have matched and swallowed it.
    expect(shouldSendFit({ cols: 80, rows: 24 }, lastSent)).toBe(true);
  });

  it("drops a measurement that is not a usable size", () => {
    expect(shouldSendFit(undefined, null)).toBe(false);
    expect(shouldSendFit({ cols: 0, rows: 30 }, null)).toBe(false);
    expect(shouldSendFit({ cols: 100, rows: 0 }, null)).toBe(false);
  });
});
