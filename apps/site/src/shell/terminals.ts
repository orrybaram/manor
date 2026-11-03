/**
 * What the agents print in their panes. This is their own output, not Manor's
 * chrome, so it's free text; it's laid out as a real terminal's rows, and a
 * pane shows its last rows when there's more than fits, as a terminal scrolls.
 *
 * Classes `.d .g .r .y .b .m .c .o` are shell.css's terminal colours.
 */
import { esc } from "./chrome";
import type { Agent, AgentId, ShellState } from "./state";

/** Full rows in a quarter pane of the 1280×800 layout: 322px of terminal at 17px a row. */
const ROWS = 18;

const SPIN = ["✶", "✻", "✽", "✻"];
const MOON = ["◐", "◓", "◑", "◒"];
const frameOf = (frames: string[], tick: number) => frames[tick % frames.length]!;

export const cursor = (focused: boolean) => `<span class="ma-cursor${focused ? "" : " ma-cursor-outline"}"> </span>`;

export function claudeBox(path: string): string[] {
  const inner = 42;
  const line = "─".repeat(inner);
  const label = ` ✻ Welcome back!   ${path}`;
  return [
    `<span class="o">╭${line}╮</span>`,
    `<span class="o">│</span> <span class="o">✻</span> Welcome back!   <span class="d">${path}</span>${" ".repeat(Math.max(0, inner - label.length))}<span class="o">│</span>`,
    `<span class="o">╰${line}╯</span>`,
  ];
}

/** How the agent's own box wraps what it's sent: `text` is plain, `first` and `rest` already HTML. */
export function wrapped(text: string, first: string, rest: string, columns: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    if (row && row.length + 1 + word.length > columns) {
      rows.push(row);
      row = word;
    } else {
      row = row ? `${row} ${word}` : word;
    }
  }
  if (row) rows.push(row);
  return rows.map((r, i) => (i === 0 ? first : rest) + esc(r));
}

const askRow = (content: string, width: number) => `<span class="y">│</span> ${content}${" ".repeat(Math.max(0, width - content.replace(/<[^>]+>/g, "").length))} <span class="y">│</span>`;

/** Codex's prompt. Its three choices are real buttons. */
function codexAsk(): string[] {
  const width = 45;
  const line = "─".repeat(width + 2);
  const choice = (act: string, label: string, sel = false) =>
    `<button class="ma-choice${sel ? " sel" : ""}" type="button" data-act="${act}" tabindex="-1">${label}</button>`;
  return [
    `<span class="y">╭${line}╮</span>`,
    askRow('<span class="y">Allow command?</span>', width),
    askRow("pnpm vitest run FileTree", width),
    askRow("", width),
    `<span class="y">│</span> ${choice("yes", "▸ Yes", true)}   ${choice("always", "Always for this session")}   ${choice("no", "No, tell me")} <span class="y">│</span>`,
    `<span class="y">╰${line}╯</span>`,
  ];
}

type Body = (a: Agent, state: ShellState, focused: boolean) => string[];

const BODIES: Record<AgentId, Body> = {
  hero: (a, state, focused) => [
    ...claudeBox("~/manor/site"),
    '<span class="d">&gt;</span> Build the hero: blackletter wordmark, the app shell,',
    "  download button. Keep the shot readable.",
    "",
    '<span class="g">●</span> Update(<b>site/hero.tsx</b>)',
    '  <span class="d">⎿  Updated with 41 additions and 12 removals</span>',
    '      <span class="r">12 -  &lt;h1&gt;Ship faster with agents&lt;/h1&gt;</span>',
    '      <span class="g">12 +  &lt;h1 className="wordmark"&gt;Manor&lt;/h1&gt;</span>',
    '      <span class="g">13 +  &lt;AppShell interactive /&gt;</span>',
    '      <span class="g">14 +  &lt;DownloadButton platform="mac" /&gt;</span>',
    "",
    '<span class="g">●</span> Bash(<b>pnpm typecheck &amp;&amp; pnpm test hero</b>)',
    '  <span class="d">⎿  Running…</span>',
    "",
    `<span class="o">${frameOf(SPIN, state.tick)} Composing… <span class="d">(${a.secs}s · ↓ ${(2.1 + a.secs / 100).toFixed(1)}k tokens · esc to interrupt)</span></span>`,
    cursor(focused),
  ],

  gtf: (a, _state, focused) => [
    '<b>&gt;_ OpenAI Codex</b> <span class="d">(research preview)</span>',
    "",
    '<span class="c">▌</span> Wire Go to File into the file drawer and add a test',
    "",
    '<span class="b">•</span> Explored',
    '  <span class="d">└ Read FileTree.tsx, useQuickOpen.ts, keymap.ts</span>',
    "",
    '<span class="b">•</span> Edited <b>src/components/files/FileTree.tsx</b> <span class="d">(+38 -6)</span>',
    '<span class="b">•</span> Added  <b>src/components/files/FileTree.test.tsx</b> <span class="d">(+64)</span>',
    "",
    ...(a.status === "requires_input" ? codexAsk() : a.log),
    cursor(focused),
  ],

  sweep: (_a, state, focused) => [
    '<span class="d">█▀▀█ █▀▀█ █▀▀ █▀▀▄ █▀▀ █▀▀█ █▀▀▄ █▀▀</span>',
    '<span class="d">█  █ █  █ █▀▀ █  █ █   █  █ █  █ █▀▀</span>',
    '<span class="d">▀▀▀▀ █▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀ ▀▀▀▀ ▀▀▀  ▀▀▀</span>',
    "",
    '<span class="m">┃</span> Sweep temperature 0.2–1.0 across the eval set and',
    '<span class="m">┃</span> chart pass@1 per model. Results go in results/.',
    "",
    '<span class="c">→</span> Read results/2026-10-29/*.jsonl <span class="d">(40 files)</span>',
    '<span class="c">→</span> Glob evals/**/*.yaml <span class="d">(118 matches)</span>',
    "",
    `  ${14 + (Math.floor(state.tick / 12) % 27)} of 40 runs complete. Comparing temperature`,
    "  0.6 against the baseline before charting…",
    "",
    `<span class="m">${frameOf(MOON, state.tick)} Thinking</span> <span class="d">· build · claude-sonnet</span>`,
    cursor(focused),
  ],

  suite: (a, state, focused) => [
    ...claudeBox("~/manor/automations"),
    '<span class="d">&gt;</span> Run the automations suite and summarise what changed',
    "",
    '<span class="g">●</span> Bash(<b>pnpm test automations</b>)',
    '  <span class="d">⎿</span>  <span class="g">✓ 212 tests passed (4.8s)</span>',
    '     <span class="d">knip: no unused exports</span>',
    "",
    '<span class="g">●</span> All green. Summary:',
    "",
    "  • Cron runs now fire from the <b>host server</b>, so",
    "    they keep going when the laptop sleeps.",
    "  • Missed runs catch up once on wake, never twice.",
    "",
    ...a.log,
    `<span class="d">&gt;</span> ${esc(focused ? state.typing : "")}` +
      (focused ? cursor(true) : "") +
      (focused && !state.typing ? '<span class="d">  type something…</span>' : ""),
  ],

  cron: (_a, _state, focused) => [
    ...claudeBox("~/manor/automations"),
    '<span class="d">&gt;</span> Make missed cron runs catch up once on wake',
    "",
    '<span class="g">●</span> Update(<b>host-server/automations/schedule.ts</b>)',
    '  <span class="d">⎿  Updated with 23 additions and 4 removals</span>',
    "",
    '<span class="g">●</span> Done. A run missed while the host slept now fires',
    "  once on wake, and its pane says it was late.",
    "",
    cursor(focused),
  ],

  flood: (_a, _state, focused) => [
    ...claudeBox("gpu-box:~/bench"),
    '<span class="d">&gt;</span> Flood the pane with 50k lines and time the render',
    "",
    '<span class="g">●</span> Bash(<b>node bench/flood.js --lines 50000</b>)',
    '  <span class="r">⎿  Error: connect ECONNREFUSED 10.0.4.12:5432</span>',
    "",
    '<span class="r">⎿  API Error: overloaded. Retrying in 30s…</span>',
    "",
    cursor(focused),
  ],

  pr: (_a, _state, focused) => [
    ...claudeBox("~/manor/go-to-file"),
    '<span class="g">●</span> Opened PR #487: Go to File (⌘P quick-open)',
    '  <span class="d">⎿  https://github.com/orrybaram/manor/pull/487</span>',
    "",
    cursor(focused),
  ],
};

/** An Agent's pane body: its rows as HTML, cut to the rows that fit. */
export function paneBody(state: ShellState, id: AgentId): string {
  const rows = BODIES[id](state.agents[id], state, state.focus === id);
  return rows.slice(-ROWS).join("\n");
}

/** The main checkout's plain shell, with no Agent in it. */
export const SHELL_BODY = `<span class="g">➜</span>  <span class="c">manor</span> <span class="b">git:(</span><span class="r">main</span><span class="b">)</span> ${cursor(true)}`;
