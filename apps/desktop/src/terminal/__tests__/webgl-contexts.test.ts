import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { RenderAddons } from "../addons";

type WebglCtor = NonNullable<RenderAddons["WebglAddon"]>;

/** A canvas whose WebGL context records being released. */
function fakeCanvas() {
  const loseContext = vi.fn(() => {
    gl.lost = true;
  });
  const gl = {
    lost: false,
    isContextLost: () => gl.lost,
    getExtension: (name: string) =>
      name === "WEBGL_lose_context" ? { loseContext } : null,
  };
  return { canvas: { getContext: () => gl, remove: () => {} }, loseContext };
}

/** A terminal whose element lists the canvases its add-ons put in it. */
function fakeTerm() {
  const canvases: unknown[] = [];
  const term = {
    element: { querySelectorAll: () => [...canvases] },
    loadAddon: vi.fn((addon: FakeWebgl) => addon.activate(term, canvases)),
  };
  return term;
}

let created: FakeWebgl[] = [];
let failLoad = false;
/** The renderer throws after it has put its canvas in the terminal. */
let failAfterCanvas = false;

class FakeWebgl {
  disposed = false;
  loseContext: ReturnType<typeof vi.fn> | null = null;
  private lossHandlers: (() => void)[] = [];
  private canvases: unknown[] | null = null;
  private canvas: unknown = null;
  constructor() {
    created.push(this);
  }
  onContextLoss(fn: () => void) {
    this.lossHandlers.push(fn);
    return { dispose() {} };
  }
  activate(_term: unknown, canvases: unknown[]) {
    if (failLoad) throw new Error("WebGL2 not supported");
    const { canvas, loseContext } = fakeCanvas();
    this.loseContext = loseContext;
    canvas.remove = () => {
      const at = canvases.indexOf(canvas);
      if (at >= 0) canvases.splice(at, 1);
    };
    canvases.push(canvas);
    // Before the addon holds its renderer, so its dispose leaves the canvas.
    if (failAfterCanvas) throw new Error("initializing WebGL state failed");
    this.canvas = canvas;
    this.canvases = canvases;
  }
  dispose() {
    this.disposed = true;
    if (this.canvases) this.canvases.splice(this.canvases.indexOf(this.canvas), 1);
  }
  /** What the GPU process (or Chromium's own limit) does to a context. */
  loseFromOutside() {
    for (const fn of this.lossHandlers) fn();
  }
}

const Addon = FakeWebgl as unknown as WebglCtor;

async function freshModule() {
  vi.resetModules();
  return import("../webgl-contexts");
}

function asTerm(t: ReturnType<typeof fakeTerm>) {
  return t as unknown as Terminal;
}

beforeEach(() => {
  created = [];
  failLoad = false;
  failAfterCanvas = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("claimWebgl", () => {
  it("draws every pane with WebGL while under the budget", async () => {
    const { claimWebgl, WEBGL_CONTEXT_BUDGET, liveWebglContexts } = await freshModule();

    const claims = Array.from({ length: WEBGL_CONTEXT_BUDGET }, (_, i) =>
      claimWebgl(asTerm(fakeTerm()), Addon, { shown: i === 0 }),
    );

    expect(claims.every((c) => c.active)).toBe(true);
    expect(liveWebglContexts()).toBe(WEBGL_CONTEXT_BUDGET);
  });

  it("leaves a pane opened hidden past the budget on the DOM renderer", async () => {
    const { claimWebgl, WEBGL_CONTEXT_BUDGET, liveWebglContexts } = await freshModule();
    for (let i = 0; i < WEBGL_CONTEXT_BUDGET; i++) {
      claimWebgl(asTerm(fakeTerm()), Addon, { shown: false });
    }

    const extra = claimWebgl(asTerm(fakeTerm()), Addon, { shown: false });

    expect(extra.active).toBe(false);
    expect(liveWebglContexts()).toBe(WEBGL_CONTEXT_BUDGET);
  });

  it("gives a shown pane the context of the least recently shown hidden pane", async () => {
    const { claimWebgl, WEBGL_CONTEXT_BUDGET, liveWebglContexts } = await freshModule();
    const claims = Array.from({ length: WEBGL_CONTEXT_BUDGET }, () =>
      claimWebgl(asTerm(fakeTerm()), Addon, { shown: true }),
    );
    // Hide them all, then show the first again briefly: the second is now
    // the one on screen longest ago.
    for (const c of claims) c.setShown(false);
    claims[0].setShown(true);
    claims[0].setShown(false);
    const victim = claims[1];
    const victimAddon = created[1];

    const onRendererChange = vi.fn();
    const fresh = claimWebgl(asTerm(fakeTerm()), Addon, {
      shown: true,
      onRendererChange,
    });

    expect(fresh.active).toBe(true);
    expect(victim.active).toBe(false);
    expect(victimAddon.disposed).toBe(true);
    // Released outright, not left for GC to count against Chromium's limit.
    expect(victimAddon.loseContext).toHaveBeenCalled();
    expect(claims[0].active).toBe(true);
    expect(liveWebglContexts()).toBe(WEBGL_CONTEXT_BUDGET);
    // Its own first renderer is not a swap.
    expect(onRendererChange).not.toHaveBeenCalled();
  });

  it("puts a pane back on WebGL when it is shown again", async () => {
    const { claimWebgl, WEBGL_CONTEXT_BUDGET } = await freshModule();
    const victimChanged = vi.fn();
    const victim = claimWebgl(asTerm(fakeTerm()), Addon, {
      shown: false,
      onRendererChange: victimChanged,
    });
    const others = Array.from({ length: WEBGL_CONTEXT_BUDGET }, () =>
      claimWebgl(asTerm(fakeTerm()), Addon, { shown: true }),
    );
    expect(victim.active).toBe(false);
    for (const c of others) c.setShown(false);

    victim.setShown(true);

    expect(victim.active).toBe(true);
    // Once off WebGL when the last shown pane took its context, once back.
    expect(victimChanged).toHaveBeenCalledTimes(2);
    expect(others.filter((c) => !c.active)).toHaveLength(1);
  });

  it("never takes a context from a shown pane", async () => {
    const { claimWebgl, WEBGL_CONTEXT_BUDGET } = await freshModule();
    const shown = Array.from({ length: WEBGL_CONTEXT_BUDGET }, () =>
      claimWebgl(asTerm(fakeTerm()), Addon, { shown: true }),
    );

    const extra = claimWebgl(asTerm(fakeTerm()), Addon, { shown: true });

    expect(extra.active).toBe(false);
    expect(shown.every((c) => c.active)).toBe(true);

    // Once one of them is hidden, the waiting pane takes its context.
    shown[5].setShown(false);
    expect(extra.active).toBe(true);
    expect(shown[5].active).toBe(false);
  });

  it("hands a closed pane's context to a shown pane waiting for one", async () => {
    const { claimWebgl, WEBGL_CONTEXT_BUDGET } = await freshModule();
    const shown = Array.from({ length: WEBGL_CONTEXT_BUDGET }, () =>
      claimWebgl(asTerm(fakeTerm()), Addon, { shown: true }),
    );
    const waiting = claimWebgl(asTerm(fakeTerm()), Addon, { shown: true });
    const closedAddon = created[0];

    shown[0].dispose();

    expect(closedAddon.disposed).toBe(true);
    expect(closedAddon.loseContext).toHaveBeenCalled();
    expect(waiting.active).toBe(true);
  });

  it("recreates nothing on tab switches under the budget", async () => {
    const { claimWebgl } = await freshModule();
    const a = claimWebgl(asTerm(fakeTerm()), Addon, { shown: true });
    const b = claimWebgl(asTerm(fakeTerm()), Addon, { shown: false });

    for (let i = 0; i < 5; i++) {
      a.setShown(false);
      b.setShown(true);
      b.setShown(false);
      a.setShown(true);
    }

    expect(created).toHaveLength(2);
    expect(created.every((addon) => !addon.disposed)).toBe(true);
  });

  it("brings a hidden pane that lost its context back when it is shown", async () => {
    const { claimWebgl } = await freshModule();
    const changed = vi.fn();
    const claim = claimWebgl(asTerm(fakeTerm()), Addon, {
      shown: false,
      onRendererChange: changed,
    });

    created[0].loseFromOutside();
    expect(claim.active).toBe(false);
    expect(created[0].disposed).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);

    claim.setShown(true);
    expect(claim.active).toBe(true);
    expect(created).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("retries a shown pane's lost context once, after a pause", async () => {
    vi.useFakeTimers();
    const { claimWebgl, LOST_RETRY_MS } = await freshModule();
    const claim = claimWebgl(asTerm(fakeTerm()), Addon, { shown: true });

    created[0].loseFromOutside();
    expect(claim.active).toBe(false);

    vi.advanceTimersByTime(LOST_RETRY_MS);
    expect(claim.active).toBe(true);

    // Lost again straight away: no retry loop until it is shown again.
    created[1].loseFromOutside();
    vi.advanceTimersByTime(LOST_RETRY_MS * 5);
    expect(claim.active).toBe(false);
    expect(created).toHaveLength(2);
  });

  it("keeps a pane whose add-on fails to load on the DOM renderer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { claimWebgl, liveWebglContexts } = await freshModule();
      failLoad = true;
      const claim = claimWebgl(asTerm(fakeTerm()), Addon, { shown: true });
      failLoad = false;

      claim.setShown(false);
      claim.setShown(true);

      expect(claim.active).toBe(false);
      expect(created).toHaveLength(1);
      expect(liveWebglContexts()).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores a pane after it is disposed", async () => {
    const { claimWebgl, liveWebglContexts } = await freshModule();
    const claim = claimWebgl(asTerm(fakeTerm()), Addon, { shown: true });

    claim.dispose();
    claim.setShown(false);
    claim.setShown(true);
    claim.dispose();

    expect(claim.active).toBe(false);
    expect(created).toHaveLength(1);
    expect(liveWebglContexts()).toBe(0);
  });

  it("tries again on the next show when a recovery fails, rather than giving up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { claimWebgl } = await freshModule();
      const claim = claimWebgl(asTerm(fakeTerm()), Addon, { shown: false });

      created[0].loseFromOutside();
      // The GPU process is still coming back: the first recovery fails.
      failLoad = true;
      claim.setShown(true);
      expect(claim.active).toBe(false);

      failLoad = false;
      claim.setShown(false);
      claim.setShown(true);
      expect(claim.active).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("hands a lost context's slot to a shown pane waiting for one", async () => {
    const { claimWebgl, WEBGL_CONTEXT_BUDGET } = await freshModule();
    const shown = Array.from({ length: WEBGL_CONTEXT_BUDGET }, () =>
      claimWebgl(asTerm(fakeTerm()), Addon, { shown: true }),
    );
    const waiting = claimWebgl(asTerm(fakeTerm()), Addon, { shown: true });
    expect(waiting.active).toBe(false);

    created[3].loseFromOutside();

    expect(shown[3].active).toBe(false);
    expect(waiting.active).toBe(true);
  });

  it("keeps handing out free contexts past a pane whose load fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { claimWebgl, WEBGL_CONTEXT_BUDGET } = await freshModule();
      const shown = Array.from({ length: WEBGL_CONTEXT_BUDGET }, () =>
        claimWebgl(asTerm(fakeTerm()), Addon, { shown: true }),
      );
      // Three panes wait, the most recent first in line.
      const waiting = [0, 1, 2].map(() =>
        claimWebgl(asTerm(fakeTerm()), Addon, { shown: true }),
      );
      expect(waiting.some((c) => c.active)).toBe(false);

      // Loads fail once, for whoever is first in line.
      let failures = 1;
      const realActivate = FakeWebgl.prototype.activate;
      const spy = vi
        .spyOn(FakeWebgl.prototype, "activate")
        .mockImplementation(function (this: FakeWebgl, term, canvases) {
          if (failures-- > 0) throw new Error("lost the GPU again");
          realActivate.call(this, term, canvases);
        });
      shown[0].dispose();
      shown[1].dispose();
      spy.mockRestore();

      expect(waiting.filter((c) => c.active)).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("frees the context of a canvas a failed load left behind", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { claimWebgl } = await freshModule();
      failAfterCanvas = true;
      const term = fakeTerm();
      const claim = claimWebgl(asTerm(term), Addon, { shown: true });

      expect(claim.active).toBe(false);
      expect(created[0].loseContext).toHaveBeenCalled();
      expect(term.element.querySelectorAll()).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
