/**
 * Polyfill for @xterm/headless in a Node.js environment.
 *
 * xterm's headless module expects a few browser globals to exist.
 * We shim them minimally so the headless Terminal + SerializeAddon work.
 */

const g = globalThis as Record<string, unknown>;

if (typeof g.navigator === "undefined") {
  g.navigator = { userAgent: "node" };
}

if (typeof g.window === "undefined") {
  g.window = {
    navigator: g.navigator,
    document: {
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
}

if (typeof g.self === "undefined") {
  g.self = g.window;
}

if (typeof g.document === "undefined") {
  g.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
