import { describe, expect, it } from "vitest";
import { greeting } from "./greeting";

const at = (hour: number) => new Date(2026, 0, 1, hour).getTime();

describe("greeting", () => {
  it("follows the local hour", () => {
    expect(greeting(at(8))).toBe("Good morning");
    expect(greeting(at(13))).toBe("Good afternoon");
    expect(greeting(at(21))).toBe("Good evening");
  });

  it("has late-night wordings before dawn and after 22:00", () => {
    expect(greeting(at(2))).toBe("Burning the midnight oil");
    expect(greeting(at(23))).toBe("Working late");
  });
});
