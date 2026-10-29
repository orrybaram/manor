import type { Extension } from "@codemirror/state";

/**
 * The languages the file pane highlights. Each is its own CodeMirror pack,
 * loaded the first time a file needs it (`loadLanguage`), so none of them is
 * in the startup bundle.
 */
export type FileLanguage =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "json"
  | "css"
  | "html"
  | "markdown"
  | "python"
  | "yaml"
  | "rust"
  | "go";

const BY_EXTENSION: Record<string, FileLanguage> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  yaml: "yaml",
  yml: "yaml",
  rs: "rust",
  go: "go",
};

/** The language a file is highlighted as, by its extension; null is plain text. */
export function languageFor(path: string): FileLanguage | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[base.slice(dot + 1)] ?? null;
}

/** Load one language's pack: a dynamic import, so it is its own chunk. */
export function loadLanguage(language: FileLanguage): Promise<Extension> {
  switch (language) {
    case "javascript":
      return import("@codemirror/lang-javascript").then((m) => m.javascript());
    case "jsx":
      return import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true }));
    case "typescript":
      return import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ typescript: true }),
      );
    case "tsx":
      return import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ typescript: true, jsx: true }),
      );
    case "json":
      return import("@codemirror/lang-json").then((m) => m.json());
    case "css":
      return import("@codemirror/lang-css").then((m) => m.css());
    case "html":
      return import("@codemirror/lang-html").then((m) => m.html());
    case "markdown":
      return import("@codemirror/lang-markdown").then((m) => m.markdown());
    case "python":
      return import("@codemirror/lang-python").then((m) => m.python());
    case "yaml":
      return import("@codemirror/lang-yaml").then((m) => m.yaml());
    case "rust":
      return import("@codemirror/lang-rust").then((m) => m.rust());
    case "go":
      return import("@codemirror/lang-go").then((m) => m.go());
  }
}
