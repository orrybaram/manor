import { describe, expect, it } from "vitest";
import { firstNameOf } from "./useViewerFirstName";

describe("firstNameOf", () => {
  it("takes the first word of a display name", () => {
    expect(firstNameOf("Ada Lovelace\n")).toBe("Ada");
    expect(firstNameOf("  Grace  ")).toBe("Grace");
  });

  it("is null for an empty profile name", () => {
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf("\n")).toBeNull();
  });
});
