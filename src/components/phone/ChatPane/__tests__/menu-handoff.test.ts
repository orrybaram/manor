/**
 * A menu handoff (ADR-218 D3) ends on its command's transcript line, and is
 * only live on the transcript it started on.
 */
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../electron.d";
import { endsMenuHandoff, liveMenuHandoff } from "../menu-handoff";

describe("endsMenuHandoff", () => {
  const startedAt = Date.parse("2026-10-11T12:00:00.000Z");
  const handoff = { name: "config", startedAt, transcript: "/t/a.jsonl" };
  const command = (name: string, ts: string): ChatEntry => ({
    kind: "command",
    id: `c-${name}-${ts}`,
    ts,
    name,
    args: "",
  });

  it("ends on the handoff's command, logged after it was sent", () => {
    // Claude Code writes a menu command's line when the menu completes, so it
    // lands after the send (seen on v2.1.281–v2.1.296).
    expect(endsMenuHandoff(handoff, command("config", "2026-10-11T12:00:09.000Z"))).toBe(true);
  });

  it("allows 2s of clock slack, and no more", () => {
    expect(endsMenuHandoff(handoff, command("config", "2026-10-11T11:59:58.000Z"))).toBe(true);
    expect(endsMenuHandoff(handoff, command("config", "2026-10-11T11:59:57.999Z"))).toBe(false);
  });

  it("ignores an older run of the same command", () => {
    expect(endsMenuHandoff(handoff, command("config", "2026-10-11T11:00:00.000Z"))).toBe(false);
  });

  it("ignores another command, an entry that isn't a command, and a bad ts", () => {
    expect(endsMenuHandoff(handoff, command("model", "2026-10-11T12:00:09.000Z"))).toBe(false);
    expect(
      endsMenuHandoff(handoff, { kind: "user", id: "u", ts: "2026-10-11T12:00:09.000Z", text: "/config" }),
    ).toBe(false);
    expect(endsMenuHandoff(handoff, command("config", ""))).toBe(false);
    expect(endsMenuHandoff(handoff, command("config", "soon"))).toBe(false);
  });
});

describe("liveMenuHandoff", () => {
  const handoff = { name: "resume", startedAt: 0, transcript: "/t/a.jsonl" };

  it("is live only on the transcript it started on", () => {
    expect(liveMenuHandoff(handoff, "/t/a.jsonl")).toBe(handoff);
    expect(liveMenuHandoff(handoff, "/t/b.jsonl")).toBeNull();
    expect(liveMenuHandoff(handoff, null)).toBeNull();
    expect(liveMenuHandoff(undefined, "/t/a.jsonl")).toBeNull();
  });

  it("a handoff from an agent with no transcript yet ends when one lands", () => {
    const fresh = { ...handoff, transcript: null };
    expect(liveMenuHandoff(fresh, null)).toBe(fresh);
    expect(liveMenuHandoff(fresh, "/t/a.jsonl")).toBeNull();
  });
});
