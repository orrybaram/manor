import { afterEach, describe, expect, it, vi } from "vitest";
import { floorHeight } from "./floor-layout";
import { floorColors, FloorRenderer } from "./floor-renderer";

const style = (vars: Record<string, string>) => ({
  getPropertyValue: (name: string) => vars[name] ?? "",
});

describe("floorColors", () => {
  it("follows the theme's CSS variables as the app paints them", () => {
    expect(floorColors(style({ "--fg": " #cdd6f4", "--yellow": "#f9e2af " }))).toEqual({
      dot: "#cdd6f4",
      gold: "#f9e2af",
    });
    // A light theme's foreground replaces the dark one.
    expect(floorColors(style({ "--fg": "#4c4f69", "--yellow": "#df8e1d" })).dot).toBe("#4c4f69");
  });

  it("has a fallback before the theme lands", () => {
    expect(floorColors(style({}))).toEqual({ dot: "#e9e3d3", gold: "#ffe800" });
  });
});

describe("FloorRenderer under reduced motion", () => {
  interface Mark {
    x: number;
    y: number;
    r: number;
    a: number;
  }

  /** A canvas whose 2D context records every dot it fills. */
  function fakeCanvas() {
    const marks: Mark[] = [];
    let arc: Omit<Mark, "a"> | null = null;
    const ctx = {
      globalAlpha: 1,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      setTransform: () => {},
      clearRect: () => marks.splice(0),
      beginPath: () => {
        arc = null;
      },
      arc: (x: number, y: number, r: number) => {
        arc = { x, y, r };
      },
      fill: () => {
        if (arc) marks.push({ ...arc, a: ctx.globalAlpha });
      },
      stroke: () => {},
    };
    const canvas = {
      width: 0,
      height: 0,
      dataset: {} as Record<string, string>,
      getContext: () => ctx,
    };
    return { canvas: canvas as unknown as HTMLCanvasElement, marks };
  }

  const key = (m: Mark) => `${m.x},${m.y}`;
  const byPlace = (marks: Mark[]) => new Map(marks.map((m) => [key(m), m]));

  function awakeFloor(reduced: boolean) {
    const { canvas, marks } = fakeCanvas();
    const renderer = new FloorRenderer(canvas);
    renderer.setReducedMotion(reduced);
    renderer.setSize(220, floorHeight(13), 1);
    renderer.setModel({ dots: 195, cols: 15, rows: 13, seed: 3, awake: true, meals: 0 }, 0);
    renderer.draw(0);
    expect(canvas.dataset.left).toBe("195");
    return { renderer, marks, canvas };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("breathes when motion is allowed (the contrast for the rest)", () => {
    const { renderer, marks } = awakeFloor(false);
    renderer.draw(1000);
    const early = byPlace(marks);
    renderer.draw(3500);
    const later = byPlace(marks);
    const changed = [...early].filter(([k, m]) => later.get(k)?.r !== m.r || later.get(k)?.a !== m.a);
    expect(changed.length).toBeGreaterThan(0);
  });

  it("holds still: no swell, breath, flicker or pulse", () => {
    const { renderer, marks } = awakeFloor(true);
    renderer.draw(500);
    const first = marks.map((m) => ({ ...m }));
    expect(first).toHaveLength(195);
    for (const t of [1000, 2500, 4000, 7000]) {
      // Steady frames: nothing asks for another.
      expect(renderer.draw(t)).toBe(false);
      expect(marks).toEqual(first);
    }
  });

  it("feeds with no ring and no pop: a fed dot just vanishes", () => {
    const { renderer, marks, canvas } = awakeFloor(true);
    renderer.draw(1000);
    const before = byPlace(marks);
    vi.spyOn(performance, "now").mockReturnValue(5000);
    // Three taps at the middle: every dot under the brush is fed.
    for (let i = 0; i < 3; i++) {
      renderer.pointerDown(110, floorHeight(13) / 2);
      renderer.pointerUp();
    }
    const left = Number(canvas.dataset.left);
    expect(left).toBeLessThan(195);
    for (const t of [5010, 5050, 5200]) {
      renderer.draw(t);
      // Only dots still on the floor are drawn, exactly as before: no
      // grown pop, no ring through the emptied sockets.
      expect(marks).toHaveLength(left);
      for (const m of marks) expect(m).toEqual(before.get(key(m)));
    }
  });
});
