import type { RootContent } from "hast";

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
let loading: Promise<Tokenize> | null = null;

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
export function loadTokenizer(): Promise<Tokenize> {
  loading ??= import("./syntax-highlighter").then((m) => {
    tokenizer = m.tokenize;
    return m.tokenize;
  });
  return loading;
}
