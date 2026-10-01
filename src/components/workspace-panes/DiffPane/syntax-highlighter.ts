import { refractor } from "refractor/core";
import type { RootContent } from "hast";
import javascript from "refractor/javascript";
import typescript from "refractor/typescript";
import tsx from "refractor/tsx";
import jsx from "refractor/jsx";
import css from "refractor/css";
import markup from "refractor/markup";
import json from "refractor/json";
import python from "refractor/python";
import go from "refractor/go";
import rust from "refractor/rust";
import bash from "refractor/bash";
import yaml from "refractor/yaml";
import markdown from "refractor/markdown";

/**
 * The grammars and the highlighter behind them. Loaded on demand through
 * `loadTokenizer` in `./syntax` — never imported directly — so the grammars
 * stay out of the startup bundle until a diff first highlights.
 */
refractor.register(javascript);
refractor.register(typescript);
refractor.register(tsx);
refractor.register(jsx);
refractor.register(css);
refractor.register(markup);
refractor.register(json);
refractor.register(python);
refractor.register(go);
refractor.register(rust);
refractor.register(bash);
refractor.register(yaml);
refractor.register(markdown);

export function tokenize(code: string, lang: string): RootContent[] {
  if (!refractor.registered(lang)) {
    return [{ type: "text", value: code }];
  }
  const root = refractor.highlight(code, lang);
  return root.children;
}
