/**
 * The shell as HTML strings, drawn from its state. Looks like the app, does
 * nothing real. Classes are the ones shell.css styles (`ma-*`, `ad`).
 */
import { ICONS as I } from "./icons";
import { openWorkspace, workspaceStatus, type Agent, type AgentId, type AgentStatus, type ShellState, type Workspace } from "./state";

export function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const dot = (s: AgentStatus) => `<span class="ad ${s}"></span>`;

function workspaceIcon(state: ShellState, w: Workspace): string {
  if (w.local) return I.branch;
  const s = workspaceStatus(state, w);
  if (s === "working" || s === "thinking") return dot(s);
  return s ? `<span class="ws-dot ${s}"></span>` : I.folder;
}

// ---- pane bodies ---------------------------------------------------------

const SPIN = ["✶", "✻", "✽", "✻"];
const MOON = ["◐", "◓", "◑", "◒"];
const frameOf = (frames: string[], tick: number) => frames[tick % frames.length]!;

const claudeBox = (path: string) =>
  `<span class="box"><span class="o">✻</span> Welcome back!   <span class="d">${path}</span></span>\n`;

type Body = (a: Agent, state: ShellState) => string;

const BODIES: Record<AgentId, Body> = {
  hero: (a, state) =>
    claudeBox("~/manor/site") +
    '<span class="d">&gt;</span> Build the hero: blackletter wordmark, the app shell,\n  download button. Keep the shot readable.\n\n' +
    '<span class="g">●</span> Read(<b>site/index.html</b>)\n  <span class="d">⎿  Read 214 lines</span>\n\n' +
    '<span class="g">●</span> Update(<b>site/hero.tsx</b>)\n  <span class="d">⎿  Updated with 41 additions and 12 removals</span>\n' +
    '      <span class="r">12 -  &lt;h1&gt;Ship faster with agents&lt;/h1&gt;</span>\n' +
    '      <span class="g">12 +  &lt;h1 className="wordmark"&gt;Manor&lt;/h1&gt;</span>\n' +
    '      <span class="g">13 +  &lt;AppShell interactive /&gt;</span>\n' +
    '      <span class="g">14 +  &lt;DownloadButton platform="mac" /&gt;</span>\n\n' +
    '<span class="g">●</span> Bash(<b>pnpm typecheck &amp;&amp; pnpm test hero</b>)\n  <span class="d">⎿  Running…</span>\n\n' +
    `<span class="o">${frameOf(SPIN, state.tick)} Composing… <span class="d">(${a.secs}s · ↓ ${(2.1 + a.secs / 100).toFixed(1)}k tokens · esc to interrupt)</span></span>\n<span class="cur"></span>`,

  gtf: (a) => {
    const head =
      '<b>&gt;_ OpenAI Codex</b> <span class="d">(research preview)</span>\n\n' +
      '<span class="c">▌</span> Wire Go to File into the file drawer and add a test\n\n' +
      '<span class="b">•</span> Explored\n  <span class="d">└ Read FileTree.tsx, useQuickOpen.ts, keymap.ts</span>\n\n' +
      '<span class="b">•</span> Edited <b>src/components/files/FileTree.tsx</b> <span class="d">(+38 -6)</span>\n' +
      '<span class="b">•</span> Added  <b>src/components/files/FileTree.test.tsx</b> <span class="d">(+64)</span>\n';
    if (a.status === "requires_input") {
      return (
        head +
        '<span class="ask"><span class="y">Allow command?</span><br>pnpm vitest run FileTree' +
        '<span class="opts"><button class="sel" data-act="yes" tabindex="-1">▸ Yes</button><button data-act="always" tabindex="-1">Always for this session</button><button data-act="no" tabindex="-1">No, tell me</button></span></span>\n<span class="cur"></span>'
      );
    }
    return head + a.log.join("") + '<span class="cur"></span>';
  },

  sweep: (_a, state) =>
    '<span class="logo">█▀▀█ █▀▀█ █▀▀ █▀▀▄ █▀▀ █▀▀█ █▀▀▄ █▀▀\n█  █ █  █ █▀▀ █  █ █   █  █ █  █ █▀▀\n▀▀▀▀ █▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀ ▀▀▀▀ ▀▀▀  ▀▀▀</span>' +
    '<span class="m">┃</span> Sweep temperature 0.2–1.0 across the eval set and\n<span class="m">┃</span> chart pass@1 per model. Results go in results/.\n\n' +
    '<span class="c">→</span> Read results/2026-10-29/*.jsonl <span class="d">(40 files)</span>\n' +
    '<span class="c">→</span> Glob evals/**/*.yaml <span class="d">(118 matches)</span>\n\n' +
    `  ${14 + (Math.floor(state.tick / 12) % 27)} of 40 runs complete. Comparing temperature\n  0.6 against the baseline before charting…\n\n` +
    `<span class="m">${frameOf(MOON, state.tick)} Thinking</span> <span class="d">· build · claude-sonnet</span>\n<span class="cur"></span>`,

  suite: (a, state) => {
    const focused = state.focus === "suite";
    return (
      claudeBox("~/manor/automations") +
      '<span class="d">&gt;</span> Run the automations suite and summarise what changed\n\n' +
      '<span class="g">●</span> Bash(<b>pnpm test automations</b>)\n  <span class="d">⎿</span>  <span class="g">✓ 212 tests passed (4.8s)</span>\n     <span class="d">knip: no unused exports</span>\n\n' +
      '<span class="g">●</span> All green. Summary:\n\n  • Cron runs now fire from the <b>host server</b>, so\n    they keep going when the laptop sleeps.\n  • Missed runs catch up once on wake, never twice.\n\n' +
      a.log.join("") +
      `<span class="d">&gt;</span> <span class="inp">${esc(focused ? state.typing : "")}</span>` +
      (focused ? '<span class="cur"></span>' : "") +
      (focused && !state.typing ? '<span class="d">  type something…</span>' : "")
    );
  },

  cron: () =>
    claudeBox("~/manor/automations") +
    '<span class="d">&gt;</span> Make missed cron runs catch up once on wake\n\n' +
    '<span class="g">●</span> Update(<b>host-server/automations/schedule.ts</b>)\n  <span class="d">⎿  Updated with 23 additions and 4 removals</span>\n\n' +
    '<span class="g">●</span> Done. A run missed while the host slept now fires\n  once on wake, and its pane says it was late.\n\n<span class="cur"></span>',

  flood: () =>
    claudeBox("gpu-box:~/bench") +
    '<span class="d">&gt;</span> Flood the pane with 50k lines and time the render\n\n' +
    '<span class="g">●</span> Bash(<b>node bench/flood.js --lines 50000</b>)\n  <span class="r">⎿  Error: connect ECONNREFUSED 10.0.4.12:5432</span>\n\n' +
    '<span class="r">⎿  API Error: overloaded. Retrying in 30s…</span>\n\n<span class="cur"></span>',

  pr: () =>
    claudeBox("~/manor/go-to-file") +
    '<span class="g">●</span> Opened PR #487: Go to File (⌘P quick-open)\n  <span class="d">⎿  https://github.com/orrybaram/manor/pull/487</span>\n\n<span class="cur"></span>',
};

export function paneBody(state: ShellState, id: AgentId): string {
  return BODIES[id](state.agents[id], state);
}

// ---- chrome --------------------------------------------------------------

function sidebar(state: ShellState): string {
  const workspaces = state.workspaces
    .map(
      (w) =>
        `<button class="ma-ws${w.id === state.ws ? " on" : ""}" data-ws="${w.id}" tabindex="-1"><span class="ic">${workspaceIcon(state, w)}</span>` +
        `<span class="nm">${w.local ? "local" : w.id}</span><span class="br">${w.branch}</span></button>`,
    )
    .join("");
  const agents = (Object.keys(state.agents) as AgentId[])
    .map((id) => {
      const a = state.agents[id];
      return `<button class="ma-agent" data-agent="${id}" tabindex="-1">${dot(a.status)}<span class="t">${a.title}</span></button>`;
    })
    .join("");
  return (
    `<aside class="ma-side"><div class="ma-lead">${I.left}${I.right}<span class="bell">${I.bell}</span></div>` +
    `<div class="ma-nav"><button tabindex="-1">${I.dash}Dashboard</button><button tabindex="-1">${I.tasks}Tasks</button><button tabindex="-1">${I.search}Search</button></div>` +
    `<div class="ma-rule"></div><div class="ma-sec">${I.folder}Projects<span class="plus">+</span></div>` +
    `<div class="ma-proj"><span class="chev">▾</span><span class="sw"></span>manor</div><div class="ma-wss">${workspaces}</div>` +
    `<div class="ma-grow"></div><div class="ma-sec">${I.bot}Agents<span class="all">View All</span></div>` +
    `<div class="ma-agents"><div class="sub">manor</div>${agents}</div></aside>`
  );
}

function pane(state: ShellState, id: AgentId): string {
  const a = state.agents[id];
  return (
    `<div class="ma-pane${state.focus === id ? " focus" : ""}" data-pane="${id}">` +
    `<div class="ma-ph">${dot(a.status)}<span class="ttl">${a.title} · ${a.kind}</span><button tabindex="-1" title="Split">${I.split}</button><button tabindex="-1" title="Close">${I.x}</button></div>` +
    `<div class="ma-term">${paneBody(state, id)}</div></div>`
  );
}

const EMPTY_PANE =
  `<div class="ma-pane focus"><div class="ma-ph">${I.term}<span class="ttl">zsh</span></div>` +
  '<div class="ma-term"><span class="g">➜</span>  <span class="c">manor</span> <span class="b">git:(</span><span class="r">main</span><span class="b">)</span> <span class="cur"></span></div></div>';

function main(state: ShellState): string {
  const w = openWorkspace(state);
  const s = workspaceStatus(state, w);
  const name = w.local ? "local" : w.id;
  const panes = w.panes.length ? w.panes.map((id) => pane(state, id)).join("") : EMPTY_PANE;
  return (
    `<section class="ma-main"><div class="ma-tabs"><div class="ma-tab">${s ? dot(s) : I.term}${w.local ? "main" : w.id}<span class="x">×</span></div><button class="add" tabindex="-1">+</button></div>` +
    `<div class="ma-panes ${w.panes.length > 1 ? "g4" : "g1"}">${panes}</div></section>` +
    `<footer class="ma-status"><span>manor</span><span>›</span><span>${name}</span><span class="r">${I.chart}${I.term}${I.dash}</span></footer>`
  );
}

export function renderShell(root: HTMLElement, state: ShellState): void {
  root.innerHTML = sidebar(state) + main(state);
}

/** Redraw only the panes that animate on their own, so hovers elsewhere are left alone. */
export function renderLivePanes(root: HTMLElement, state: ShellState): void {
  for (const id of ["hero", "sweep"] as const) {
    const el = root.querySelector(`[data-pane="${id}"] .ma-term`);
    if (el) el.innerHTML = paneBody(state, id);
  }
}
