/**
 * What a pane *should* look like, rebuilt from the daemon's own record.
 *
 * A pane that shows garbage — words strewn across the screen, a transcript in
 * staircases — is a grid that disagreed with the program about its width at
 * some point. Whether that disagreement was the daemon's or a client's is the
 * first question, and this answers it: it replays the session's bytes into a
 * headless terminal, resizing at exactly the stream positions the daemon
 * logged in `resizes.jsonl`. A clean replay of a pane that was garbled on
 * screen means the client put a resize in the wrong place.
 *
 *   node scripts/replay-session.ts <session dir> [--at=<file byte>] [--lines=<n>]
 *
 * `<session dir>` is `~/.manor/sessions/<pane id>` on the machine the pane runs
 * on. `--at` stops the replay at a byte of `scrollback.bin`; `--lines` is how
 * much of the bottom of the buffer to print (default 60). Each printed row is
 * prefixed `W|` when xterm marked it as soft-wrapped and ` |` otherwise.
 *
 * Run directly by Node, which strips the types.
 */

import fs from "fs";
import path from "path";
import headless from "@xterm/headless";

const { Terminal } = headless;

interface LoggedResize {
  offset: number;
  cols: number;
  rows: number;
}

function arg(name: string): string | undefined {
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.error("usage: node scripts/replay-session.ts <session dir> [--at=<byte>] [--lines=<n>]");
  process.exit(1);
}

const bytes = fs.readFileSync(path.join(dir, "scrollback.bin"));
const logLines = fs
  .readFileSync(path.join(dir, "resizes.jsonl"), "utf-8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Record<string, number>);

// The last `fileStartsAt` is where the file starts now; the first line also
// carries the size the session was created at.
const created = logLines[0];
const fileStartsAt = logLines.filter((e) => e.fileStartsAt !== undefined).at(-1)!.fileStartsAt;
const all: LoggedResize[] = logLines
  .filter((e) => e.at !== undefined)
  .map((e) => ({ offset: e.at - fileStartsAt, cols: e.cols, rows: e.rows }));
// Resizes cut off with the bytes before them still set the size the file's
// first byte was drawn at.
const before = all.filter((r) => r.offset <= 0).at(-1);
const resizes = all.filter((r) => r.offset > 0);

const end = Math.min(Number(arg("at") ?? bytes.length), bytes.length);
const lines = Number(arg("lines") ?? 60);

const start = before ?? { cols: created.cols, rows: created.rows };
const term = new Terminal({
  cols: start.cols,
  rows: start.rows,
  scrollback: 10_000,
  allowProposedApi: true,
});
const write = (data: Uint8Array) =>
  new Promise<void>((resolve) => term.write(data, resolve));

let pos = 0;
for (const r of resizes) {
  if (r.offset > end) break;
  await write(bytes.subarray(pos, r.offset));
  pos = r.offset;
  term.resize(r.cols, r.rows);
  console.log(`resize at byte ${r.offset}: ${r.cols}x${r.rows}`);
}
await write(bytes.subarray(pos, end));

const buffer = term.buffer.active;
console.log(`\n${term.cols}x${term.rows}, replayed to byte ${end} of ${bytes.length}:\n`);
for (let i = Math.max(0, buffer.length - lines); i < buffer.length; i++) {
  const line = buffer.getLine(i);
  if (!line) continue;
  console.log((line.isWrapped ? "W|" : " |") + line.translateToString(true));
}
