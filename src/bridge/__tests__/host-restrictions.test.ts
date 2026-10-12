import { describe, expect, it } from "vitest";

import { settle } from "../client";
import {
  HOST_UNAVAILABLE_COPY,
  isHostRestricted,
  unlessHostRestricted,
} from "../host-restrictions";
import { useToastStore } from "../../store/toast-store";

describe("host restrictions", () => {
  it("an unavailable:host result marks the host and new-workspace degrades to the copy", () => {
    const action = () => {
      ran = true;
    };
    let ran = false;
    unlessHostRestricted(action);
    expect(ran).toBe(true);

    expect(() =>
      settle({ id: 1, kind: "result", ok: false, error: "no", code: "unavailable:host" }),
    ).toThrow();
    expect(isHostRestricted()).toBe(true);

    ran = false;
    unlessHostRestricted(action);
    expect(ran).toBe(false);
    expect(useToastStore.getState().toasts.slice(-1)[0]?.message).toBe(HOST_UNAVAILABLE_COPY);
  });
});
