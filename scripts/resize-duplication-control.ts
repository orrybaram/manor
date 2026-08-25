/**
 * How much of the resize duplication is manor's, and how much is a terminal's?
 *
 * Runs the same experiment as `tests/e2e/claude-resize-duplication.spec.ts` —
 * literally the same, the prompt and markers and counting are imported from
 * `helpers/zq-run` — but against a *local* terminal: one process, node-pty and
 * xterm, `term.resize()` and `pty.resize()` in one function between two reads,
 * which is the ordering every native emulator has for free. Whatever this
 * leaves behind is the floor. Anything manor strands beyond it is manor's.
 *
 *   node scripts/resize-duplication-control.ts [--order=grid-first|pty-first]
 *
 * Run directly by Node, which strips the types. `--order=pty-first` models
 * manor's ordering instead: the ioctl lands, and the grid follows at the
 * marker the daemon publishes (ADR-164).
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as pty from "node-pty";
import headless from "@xterm/headless";
import serializeAddon from "@xterm/addon-serialize";
import { flatten, stripAnsi } from "../tests/e2e/helpers/ansi.ts";
import {
  DRAG_SIZES,
  DRAG_START,
  LAST_MARKER,
  PROMPT,
  duplicates,
} from "../tests/e2e/helpers/zq-run.ts";

const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

const here = path.dirname(fileURLToPath(import.meta.url));
const ORDER = process.argv.includes("--order=pty-first")
  ? "pty-first"
  : "grid-first";

/** How long each settled size is held, matching the drag the spec drives. */
const HOLD_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A HOME with this machine's Claude login and nothing else about its work. */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-control-"));
  const real = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"),
  );
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ ...real, projects: {}, mcpServers: {} }),
  );
  fs.mkdirSync(path.join(home, ".claude"));
  const creds = path.join(home, ".claude/.credentials.json");
  execFileSync(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { stdio: ["ignore", fs.openSync(creds, "w", 0o600), "ignore"] },
  );
  const work = path.join(home, "work");
  fs.mkdirSync(work);
  return { home, work };
}

const { home, work } = makeHome();

const term = new Terminal({
  cols: DRAG_START[0],
  rows: DRAG_START[1],
  scrollback: 20_000,
  allowProposedApi: true,
});
const serialize = new SerializeAddon();
term.loadAddon(serialize);

const child = pty.spawn(
  path.join(os.homedir(), ".local/bin/claude"),
  ["--model", "sonnet"],
  {
    name: "xterm-256color",
    cols: DRAG_START[0],
    rows: DRAG_START[1],
    cwd: work,
    env: Object.fromEntries(
      Object.entries({ ...process.env, HOME: home }).filter(
        ([k]) => !k.startsWith("CLAUDE_CODE") && !k.startsWith("ANTHROPIC_"),
      ),
    ) as Record<string, string>,
  },
);

let raw = "";
child.onData((d) => {
  raw += d;
  term.write(d);
});

/** Wait until the flattened stream satisfies `predicate`. */
async function until(
  what: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(flatten(raw))) return;
    await sleep(200);
  }
  throw new Error(
    `timed out waiting for ${what}. Pane held:\n${stripAnsi(raw).slice(-1500)}`,
  );
}

/** Let xterm's write queue drain before reading the buffer. */
const drain = () => new Promise<void>((r) => term.write("", r));

const onScreen = () =>
  duplicates(stripAnsi(serialize.serialize({ scrollback: 20_000 })));

await until(
  "the prompt or the trust question",
  (t) => t.includes("Welcomeback") || /trust/i.test(t),
  120_000,
);
if (/trust/i.test(flatten(raw))) {
  child.write("\r");
  await until("the prompt", (t) => t.includes("Welcomeback"), 120_000);
}
await sleep(2_000);

// Text first, Enter after a beat: submitted in one write, Claude's input
// treats the trailing carriage return as part of the pasted line and never
// sends it.
child.write(PROMPT);
await sleep(500);
child.write("\r");

await until("the last marker", (t) => t.includes(LAST_MARKER), 240_000);
await sleep(4_000);
await drain();

console.log(`[control] order=${ORDER}`);
console.log(`[control] before the drag: ${onScreen().length} duplicated`);

for (const [cols, rows] of DRAG_SIZES) {
  if (ORDER === "grid-first") {
    term.resize(cols, rows);
    child.resize(cols, rows);
  } else {
    child.resize(cols, rows);
    await sleep(2);
    term.resize(cols, rows);
  }
  await sleep(HOLD_MS);
}
await sleep(4_000);
await drain();

const dupes = onScreen();
console.log(`[control] after the drag:  ${dupes.length} duplicated`);
if (dupes.length) console.log(`[control] ${dupes.slice(0, 24).join(" ")}`);

const out = path.join(here, "../tests/e2e/artifacts/control");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "scrollback.bin"), raw);
console.log(`[control] stream saved to ${out}`);

child.kill();
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
