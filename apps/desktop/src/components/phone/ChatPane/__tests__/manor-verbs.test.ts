import { describe, expect, it } from "vitest";
import { MANOR_VERBS, pastVerb, presentVerb } from "../manor-verbs";

describe("manor verbs", () => {
  it("has the twelve present / past pairs", () => {
    expect(MANOR_VERBS.map((v) => `${v.present}/${v.past}`)).toEqual([
      "Tending/Tended",
      "Sweeping/Swept",
      "Dusting/Dusted",
      "Polishing/Polished",
      "Mending/Mended",
      "Tidying/Tidied",
      "Airing out/Aired out",
      "Stoking/Stoked",
      "Pruning/Pruned",
      "Cataloguing/Catalogued",
      "Steeping/Steeped",
      "Furnishing/Furnished",
    ]);
  });

  it("picks a turn's past verb by its id, the same every time", () => {
    const pasts = new Set(MANOR_VERBS.map((v) => v.past));
    const id = "00000000-0000-4000-8000-000000000021";
    expect(pasts.has(pastVerb(id))).toBe(true);
    expect(pastVerb(id)).toBe(pastVerb(id));
    // Different turns don't all say the same.
    const picked = new Set(Array.from({ length: 50 }, (_, i) => pastVerb(`turn-${i}`)));
    expect(picked.size).toBeGreaterThan(4);
  });

  it("walks the present tense round the list", () => {
    expect(presentVerb(0)).toBe("Tending");
    expect(presentVerb(11)).toBe("Furnishing");
    expect(presentVerb(12)).toBe("Tending");
    expect(presentVerb(-1)).toBe("Furnishing");
  });
});
