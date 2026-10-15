import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShownLayer } from "../layer-shown";
import { useLayerShown } from "../layer-shown-context";

function Probe() {
  return useLayerShown() ? "shown" : "hidden";
}

/** Render a probe inside layers shown as given, outermost first. */
function probeIn(...layers: boolean[]): string {
  let node: React.ReactNode = createElement(Probe);
  for (const shown of [...layers].reverse()) {
    node = createElement(ShownLayer, { shown, children: node });
  }
  return renderToStaticMarkup(createElement("div", null, node));
}

describe("useLayerShown", () => {
  it("is shown outside any layer", () => {
    expect(probeIn()).toContain(">shown<");
  });

  it("is shown only while every layer around it is", () => {
    expect(probeIn(true, true)).toContain(">shown<");
    // A selected tab in a hidden workspace is not on screen.
    expect(probeIn(false, true)).toContain(">hidden<");
    expect(probeIn(true, false)).toContain(">hidden<");
  });
});
