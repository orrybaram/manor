import type { RootContent } from "hast";
import { loadOnce } from "../../../lib/load-once";

export type Tokenize = (code: string, lang: string) => RootContent[];

const EXT_MAP: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  css: "css",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  json: "json",
  py: "python",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  mdx: "markdown",
};

export function extToLang(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? null;
}

let tokenizer: Tokenize | null = null;
const listeners = new Set<() => void>();

/**
 * The highlighter, once it has loaded — `null` until then. Lets a diff opened
 * after the first one highlight on its first render instead of flashing plain
 * text for a tick.
 */
export function loadedTokenizer(): Tokenize | null {
  return tokenizer;
}

/**
 * Load the highlighter and its grammars. They are a few hundred kilobytes the
 * app has no use for until a diff pane first highlights, so they live in their
 * own chunk; every caller shares the one load.
 */
export const loadTokenizer = loadOnce(() =>
  import("./syntax-highlighter").then((m) => {
    tokenizer = m.tokenize;
    for (const listener of listeners) listener();
    return m.tokenize;
  }),
);

/**
 * Subscribe to the highlighter arriving, for `useSyncExternalStore`.
 * Subscribing is what asks for it: the load starts with the first diff that
 * wants highlighting.
 */
export function subscribeTokenizer(onLoad: () => void): () => void {
  listeners.add(onLoad);
  if (!tokenizer) {
    loadTokenizer().catch(() => {
      // No highlighter is plain text, which every row already renders. The
      // next diff to subscribe tries the load again.
    });
  }
  return () => {
    listeners.delete(onLoad);
  };
}
