import { expect, test } from "./fixtures";

test("app boots", async ({ window }) => {
  const title = await window.title();
  expect(title).toContain("Manor");
});
