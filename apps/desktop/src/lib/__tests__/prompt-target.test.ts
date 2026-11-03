import { describe, expect, it } from "vitest";
import { pickPromptTarget, type PromptCandidate } from "../prompt-target";

const agent = (over: Partial<PromptCandidate> & { id: string }) => ({
  status: "active",
  lastAgentStatus: "idle",
  paneId: `pane-${over.id}`,
  updatedAt: "2026-10-30T10:00:00Z",
  ...over,
});

describe("pickPromptTarget", () => {
  const live = () => true;

  it("picks the most recently active waiting agent", () => {
    const picked = pickPromptTarget(
      [
        agent({ id: "a", updatedAt: "2026-10-30T09:00:00Z" }),
        agent({ id: "b", lastAgentStatus: "responded", updatedAt: "2026-10-30T11:00:00Z" }),
      ],
      live,
    );
    expect(picked?.id).toBe("b");
  });

  it("never picks an agent mid-turn, asking for input, finished or paneless", () => {
    expect(
      pickPromptTarget(
        [
          agent({ id: "a", lastAgentStatus: "working" }),
          agent({ id: "b", lastAgentStatus: "requires_input" }),
          agent({ id: "c", status: "completed" }),
          agent({ id: "d", paneId: null }),
        ],
        live,
      ),
    ).toBeNull();
  });

  it("skips an agent whose pane is gone", () => {
    expect(pickPromptTarget([agent({ id: "a" })], () => false)).toBeNull();
  });
});
