import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { gfmPipeline } from "../gfm-pipeline";

describe("GfmMarkdown footnotes", () => {
  it("renders one prefixed id per in-page link, matching jumpTo's lookup", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, gfmPipeline, "Hi[^1]\n\n[^1]: note"),
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    const hrefs = [...html.matchAll(/ href="#([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["fn-1", "fnref-1"]);
    for (const href of hrefs) {
      // jumpTo looks up `user-content-${href}`
      expect(ids).toContain(`user-content-${href}`);
    }
  });
});
