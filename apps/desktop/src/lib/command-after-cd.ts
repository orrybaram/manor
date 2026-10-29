/** `cd <one word, or a quoted path> && ` at the start of a line. */
const LEADING_CD = /^\s*cd\s+(?:'(?:[^']|'"'"')*'|"(?:[^"\\]|\\.)*"|\S+)\s*&&\s*/;

/**
 * The command a line runs once its leading `cd <folder> &&`s are done: what
 * names the agent in `cd '/repo/api' && codex resume <id>`.
 */
export function commandAfterCd(line: string): string {
  let rest = line;
  for (let m = LEADING_CD.exec(rest); m; m = LEADING_CD.exec(rest)) rest = rest.slice(m[0].length);
  return rest.trimStart();
}
