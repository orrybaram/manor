import { describe, expect, it } from "vitest";
import { createLatestOnly } from "./latest-only";

describe("createLatestOnly", () => {
  it("drops an older read that lands after a newer one", async () => {
    const order = createLatestOnly();
    const shown: string[] = [];
    const read = (content: string, ms: number) => {
      const ticket = order.begin();
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (order.isLatest(ticket)) shown.push(content);
          resolve();
        }, ms),
      );
    };
    await Promise.all([read("old", 20), read("new", 1)]);
    expect(shown).toEqual(["new"]);
  });

  it("keeps a read when nothing newer started", () => {
    const order = createLatestOnly();
    const ticket = order.begin();
    expect(order.isLatest(ticket)).toBe(true);
    order.begin();
    expect(order.isLatest(ticket)).toBe(false);
  });
});
