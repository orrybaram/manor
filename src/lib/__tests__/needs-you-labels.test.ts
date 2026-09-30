import { describe, expect, it } from "vitest";
import { cardColor } from "../../components/sidebar/HomeDashboard/needs-you-labels";
import type { NeedsYouCard } from "../home-dashboard-studio";

const pr = (blocker: { kind: string } | null): NeedsYouCard =>
  ({ kind: "pr", tier: blocker ? "blocked" : "ready", blocker }) as unknown as NeedsYouCard;
const agent = (tier: string): NeedsYouCard =>
  ({ kind: "agent", tier }) as unknown as NeedsYouCard;

describe("cardColor", () => {
  it.each([
    ["conflicts", pr({ kind: "conflicts" }), "var(--red)"],
    ["checks", pr({ kind: "checks" }), "var(--red)"],
    ["changes-requested", pr({ kind: "changes-requested" }), "var(--yellow)"],
    ["threads", pr({ kind: "threads" }), "var(--yellow)"],
    ["ready PR", pr(null), "var(--green)"],
    ["input agent", agent("input"), "var(--red)"],
    ["finished agent", agent("finished"), "var(--cyan)"],
  ])("%s", (_name, card, color) => {
    expect(cardColor(card)).toBe(color);
  });
});
