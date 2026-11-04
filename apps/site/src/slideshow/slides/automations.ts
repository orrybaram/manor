// Automations: Settings' Automations page. A card opens its automation's page, and Run now
// starts its agent the way the app does: the Automations folder's workspace, then the run's
// row, then the agent in the sidebar, from AutomationsPage/, automations/fire-run.ts and
// automations/run-agent.ts.
import "./automations.css";
import { esc, leafPane, tabbedPanel, type ProjectRow, type WorkspaceRow } from "../../shell/chrome";
import { icon } from "../../shell/icons";
import { TICK_MS } from "../../shell/render";
import { toWorkspaceIndicator, type AgentStatus } from "../../shell/state";
import { claudeBox, cursor } from "../../shell/terminals";
import type { Slide } from "../slide";
import { keepKeysInSettings, settingsModal } from "./settings-modal";

const REMOTE_HOST = "boathouse";
const TERMINAL_COLUMNS = 100;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** lib/automations.ts `DEFAULT_MISSED_GRACE_MINUTES`, as automation-text.ts's `scheduleNote` says it. */
const GRACE_HOURS = 12;

/** The shapes the page's presets write: every hour, every day, or on some days. */
type Schedule = { minute: number; hour: number | null; days: readonly number[] | null };

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** cronFromPreset. */
function cronOf(s: Schedule): string {
  if (s.hour === null) return `${s.minute} * * * *`;
  if (!s.days) return `${s.minute} ${s.hour} * * *`;
  return `${s.minute} ${s.hour} * * ${s.days.length === 5 ? "1-5" : s.days[0]}`;
}

/** lib/cron-describe.ts `describeCron`. */
function describe(s: Schedule): string {
  if (s.hour === null) return s.minute === 0 ? "Every hour" : `Every hour at :${pad(s.minute)}`;
  const at = `${pad(s.hour)}:${pad(s.minute)}`;
  if (!s.days) return `Every day at ${at}`;
  return s.days.length === 5 ? `Weekdays at ${at}` : `${WEEKDAY_NAMES[s.days[0]!]}s at ${at}`;
}

/** The schedule's next or last `count` times from `from`, in the viewer's zone: what `nextOccurrences` asks croner, for these shapes. */
function occurrences(s: Schedule, from: Date, count: number, direction: 1 | -1): Date[] {
  const found: Date[] = [];
  for (let day = 0; found.length < count && day < 400; day++) {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + day * direction);
    if (s.days && !s.days.includes(date.getDay())) continue;
    const hours = s.hour === null ? [...Array(24).keys()] : [s.hour];
    for (const hour of direction === 1 ? hours : hours.reverse()) {
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, s.minute);
      if ((at.getTime() - from.getTime()) * direction > 0 && found.length < count) found.push(at);
    }
  }
  return found;
}

/** automation-text.ts `relativeWhen`, in the viewer's zone. */
function relativeWhen(d: Date, now: Date): string {
  const dayNumber = (x: Date) => Math.round(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000);
  const days = dayNumber(d) - dayNumber(now);
  if (days === 0) return `Today ${clock(d)}`;
  if (days === 1) return `Tomorrow ${clock(d)}`;
  if (days === -1) return `Yesterday ${clock(d)}`;
  if (days > 1 && days < 7) return `${DAYS[d.getDay()]} ${clock(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(d)}`;
}

/** automation-text.ts `dayAndTime`, `historyTime`. */
const dayAndTime = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(d)}`;
const historyTime = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(d)}`;

/** lib/cron-describe.ts `timezoneLabel`, of the viewer's zone, which is what a new automation is written in. */
function timezoneLabel(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (zone === "UTC" || zone === "Etc/UTC" || zone === "Etc/GMT" || zone === "GMT") return "UTC";
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

type RunTone = "ok" | "input" | "work" | "skip" | "fail";
type RunStatusText = { label: string; tone: RunTone };

/** automation-text.ts `STATUS_TEXT`. */
const STATUS_TEXT: Record<AgentStatus, RunStatusText> = {
  thinking: { label: "Thinking", tone: "work" },
  working: { label: "Working", tone: "work" },
  requires_input: { label: "Needs input", tone: "input" },
  responded: { label: "Responded", tone: "ok" },
  error: { label: "Error", tone: "fail" },
  idle: { label: "Exited", tone: "skip" },
};

type Agent = {
  id: string;
  title: string;
  project: string;
  ws: string;
  status: AgentStatus;
  /** Finished off screen and not looked at yet: what makes a dot pulse. */
  unseen: boolean;
  log: string[];
  secs: number;
};

type Run = {
  id: number;
  firedAt: Date;
  /** The run's row: automation-text.ts `runWhatText`'s words. */
  what: string;
  skipped: boolean;
  /** Its Agent, once the first hook has made one. */
  agent: Agent | null;
  /** An Agent that's gone: its status reads Exited, and it has no pane to open. */
  gone: boolean;
};

type Automation = {
  id: string;
  name: string;
  schedule: Schedule;
  project: string;
  host: "local" | "remote";
  /** The workspace it reuses, by the name the chip gives it, or null for a new one each run. */
  reuse: string | null;
  prompt: string;
  enabled: boolean;
  runs: Run[];
  /** What its agent does in a run. */
  plan: { tool: string; toolResult: string; reply: string; ends: AgentStatus };
};

type Ws = { id: string; name: string; branch: string; isMain: boolean; inFolder: boolean; project: string };

/** automation-text.ts `runStatusText`. */
function statusOf(run: Run): RunStatusText {
  if (run.skipped) return { label: "Skipped", tone: "skip" };
  if (run.agent) return STATUS_TEXT[run.agent.status];
  return run.gone ? STATUS_TEXT.idle : { label: "Starting", tone: "work" };
}

const runStatus = (s: RunStatusText) => `<span class="ma-au-status ma-au-${s.tone}"><span class="ma-au-dot" aria-hidden="true"></span>${s.label}</span>`;

/** How the agent's own box wraps what it's given. */
function wrapped(text: string, first: string, rest: string): string[] {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    if (row && row.length + 1 + word.length > TERMINAL_COLUMNS) {
      rows.push(row);
      row = word;
    } else {
      row = row ? `${row} ${word}` : word;
    }
  }
  if (row) rows.push(row);
  return rows.map((r, i) => (i === 0 ? first : rest) + esc(r));
}

const firstSentence = (prompt: string) => prompt.split(/(?<=\.)\s/)[0]!;

export const automations: Slide = {
  id: "automations",
  label: "Automations",
  title: "Agents on a schedule.",
  description: "A remote host fires them on its own, so they run with your laptop shut. This Mac runs its own while Manor is open.",
  hint: "Open an automation, then press Run now.",
  alt: "An interactive mock of Manor's Settings, open on Automations: cards for agents that start on a schedule, grouped by host, each with its next run and its last run's status.",
  enter(ctx) {
    const { root } = ctx;
    const now = new Date();
    const zone = timezoneLabel();

    let nextRun = 0;
    let nextAgent = 0;

    const workspaces: Ws[] = [
      { id: "harbor-local", name: "local", branch: "main", isMain: true, inFolder: false, project: "harbor" },
      { id: "lantern-local", name: "local", branch: "main", isMain: true, inFolder: false, project: "lantern" },
    ];
    const agents: Agent[] = [];

    /** fire-run.ts `runWorkspaceNames`, a second run in one minute taking its ` (2)` and `-2`. */
    const runWorkspace = (a: Automation, at: Date): Ws => {
      const baseName = `${a.name} · ${MONTHS[at.getMonth()]} ${at.getDate()} ${clock(at)}`;
      const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "automation";
      const baseBranch = `auto/${slug}-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
      let name = baseName;
      let branch = baseBranch;
      for (let n = 2; workspaces.some((w) => w.name === name || w.branch === branch); n++) {
        name = `${baseName} (${n})`;
        branch = `${baseBranch}-${n}`;
      }
      const ws: Ws = { id: `run-${branch}`, name, branch, isMain: false, inFolder: true, project: a.project };
      workspaces.push(ws);
      return ws;
    };

    /** Short enough for the agent's welcome box. */
    const dir = (ws: Ws, a: { project: string }) => (ws.isMain ? `~/${a.project}` : `~/${a.project}/auto-run`);

    /** The run's Agent, made by its first hook. */
    const startAgent = (a: Automation, ws: Ws, status: AgentStatus): Agent => {
      const agent: Agent = {
        id: `agent-${nextAgent++}`,
        title: firstSentence(a.prompt),
        project: a.project,
        ws: ws.id,
        status,
        unseen: false,
        secs: 0,
        log: [...claudeBox(dir(ws, a)), ...wrapped(a.prompt, '<span class="d">&gt;</span> ', "  "), ""],
      };
      agents.push(agent);
      return agent;
    };

    const toolRows = (a: Automation) => [`<span class="g">●</span> ${a.plan.tool}`, `  <span class="d">⎿  ${a.plan.toolResult}</span>`, ""];
    const finish = (agent: Agent, a: Automation) => {
      agent.status = a.plan.ends;
      agent.log.push(...wrapped(a.plan.reply, '<span class="g">●</span> ', "  "), "");
      agent.unseen = !(page === null && ws === agent.ws);
    };

    const pastRun = (at: Date, what: string, extra: Partial<Run> = {}): Run => ({ id: nextRun++, firedAt: at, what, skipped: false, agent: null, gone: true, ...extra });

    const define = (a: Omit<Automation, "runs">): Automation => ({ ...a, runs: [] });

    const morning = define({
      id: "morning-pr-triage",
      name: "Morning PR triage",
      schedule: { minute: 0, hour: 9, days: [1, 2, 3, 4, 5] },
      project: "harbor",
      host: "local",
      reuse: null,
      prompt: "Look through the open pull requests in this repo. For each one waiting on review, summarise what changed and flag anything risky.",
      enabled: true,
      plan: { tool: "Bash(<b>gh pr list --state open</b>)", toolResult: "3 open pull requests", reply: "Three pull requests are waiting on review. The dock fees one changes how fees round, so read that one first.", ends: "responded" },
    });
    const changelog = define({
      id: "weekly-changelog-draft",
      name: "Weekly changelog draft",
      schedule: { minute: 0, hour: 16, days: [5] },
      project: "harbor",
      host: "local",
      reuse: null,
      prompt: "Draft this week's changelog from the merged pull requests.",
      enabled: false,
      plan: { tool: "Write(<b>CHANGELOG.md</b>)", toolResult: "Wrote 18 lines", reply: "Drafted this week's changelog in CHANGELOG.md.", ends: "responded" },
    });
    const nightly = define({
      id: "nightly-dependency-bump",
      name: "Nightly dependency bump",
      schedule: { minute: 0, hour: 2, days: null },
      project: "lantern",
      host: "remote",
      reuse: null,
      prompt: "Update the dependencies with patch releases and run the tests. Open a pull request if they pass.",
      enabled: true,
      plan: { tool: "Bash(<b>pnpm update --latest && pnpm test</b>)", toolResult: "Tests passed", reply: "Tests pass, but one update changes the lockfile format. Should I open the pull request anyway?", ends: "requires_input" },
    });
    const watchCi = define({
      id: "watch-ci-on-main",
      name: "Watch CI on main",
      schedule: { minute: 15, hour: null, days: null },
      project: "lantern",
      host: "remote",
      reuse: "main",
      prompt: "Check the latest CI run on main. If it failed, say why in one paragraph.",
      enabled: true,
      plan: { tool: "Bash(<b>gh run list --branch main --limit 1</b>)", toolResult: "1 run, passing", reply: "CI on main is green.", ends: "responded" },
    });
    const list = [morning, changelog, nightly, watchCi];

    // The runs that have already happened, so the page opens lived in.
    {
      const [last, ...older] = occurrences(morning.schedule, now, 3, -1);
      const lastWs = runWorkspace(morning, last!);
      const agent = startAgent(morning, lastWs, "responded");
      agent.log.push(...toolRows(morning), ...wrapped(morning.plan.reply, '<span class="g">●</span> ', "  "), "");
      morning.runs = [pastRun(last!, `Opened ${lastWs.name}`, { agent, gone: false }), pastRun(older[0]!, "Started"), pastRun(older[1]!, "Caught up · Manor was closed")];
    }
    {
      const [last, ...older] = occurrences(nightly.schedule, now, 3, -1);
      const lastWs = runWorkspace(nightly, last!);
      const agent = startAgent(nightly, lastWs, "requires_input");
      agent.unseen = true;
      agent.log.push(...toolRows(nightly), ...wrapped(nightly.plan.reply, '<span class="g">●</span> ', "  "), "");
      nightly.runs = [pastRun(last!, "Caught up · host was asleep", { agent, gone: false }), pastRun(older[0]!, "Started"), pastRun(older[1]!, "Skipped · previous run still working", { skipped: true })];
    }
    {
      const [last, ...older] = occurrences(watchCi.schedule, now, 3, -1);
      watchCi.runs = [pastRun(last!, "Skipped · previous run still working", { skipped: true }), pastRun(older[0]!, "Opened main"), pastRun(older[1]!, "Opened main")];
    }

    let page: "list" | Automation | null = "list";
    let ws = "harbor-local";
    /** The tab showing in each workspace: its agent, or the shell without. */
    const shownAgent = new Map<string, string>();
    const busy = new Set<Automation>();
    let unread = true;
    let projectsOpen = true;
    let scrollTop = 0;
    let focusField: { name: string; start: number; end: number } | null = null;
    let clicked = false;
    let tick = 0;
    let sinceTick = 0;

    // ---- the list -----------------------------------------------------------

    const row = (a: Automation) => {
      const last = a.runs[0];
      const next = occurrences(a.schedule, new Date(), 1, 1)[0]!;
      return (
        `<button class="ma-au-row${a.enabled ? "" : " ma-au-paused"}" type="button" tabindex="-1" data-au-open="${a.id}">` +
        `<span class="ma-au-badge" aria-hidden="true">${icon("calendar-clock", 15)}</span>` +
        `<span class="ma-au-cell-name"><span class="ma-au-name">${esc(a.name)}</span>` +
        `<span class="ma-au-sub">${describe(a.schedule)} · ${a.project} · Claude</span></span>` +
        `<span class="ma-au-cell-when">` +
        (a.enabled ? `<span class="ma-au-pill" title="${esc(zone)} time">${relativeWhen(next, new Date())}</span>` : `<span class="ma-au-pill">Paused</span>`) +
        (last ? runStatus(statusOf(last)) : `<span class="ma-au-never">Never run</span>`) +
        `</span><span class="ma-au-chevron" aria-hidden="true">${icon("chevron-right", 13)}</span></button>`
      );
    };

    const group = (title: string, note: string, items: Automation[]) =>
      `<div role="group"><div class="ma-au-group-title">${title}${note ? `<span class="ma-au-group-note"> · ${note}</span>` : ""}</div><div class="ma-au-cards">${items.map(row).join("")}</div></div>`;

    const listPage = () =>
      `<div class="ma-au-page"><div class="ma-au-header"><div class="ma-section-label">Automations</div>` +
      `<button class="ma-btn ma-primary ma-sm" type="button" tabindex="-1"><span class="ma-au-button-icon">${icon("plus", 12)}</span>New automation</button></div>` +
      `<div class="ma-au-description">Agents that start on a schedule. Remote hosts run them with this app closed.</div>` +
      `<div class="ma-au-table">${group("This Mac", "runs only while Manor is open", list.filter((a) => a.host === "local"))}${group(REMOTE_HOST, "", list.filter((a) => a.host === "remote"))}</div></div>`;

    // ---- one automation's page ----------------------------------------------

    const chip = (label: string) =>
      `<button class="ma-au-chip" type="button" tabindex="-1" aria-haspopup="menu">${esc(label)}<span class="ma-au-chip-caret">${icon("chevron-down", 10)}</span></button>`;

    const runRow = (run: Run) => {
      const cells = `<span class="ma-au-hist-time">${historyTime(run.firedAt)}</span><span class="ma-au-hist-what">${esc(run.what)}</span>${runStatus(statusOf(run))}`;
      // RunHistory: a row opens the run's agent only if it has one.
      if (run.agent) return `<button class="ma-au-hist-row" type="button" tabindex="-1" title="Open this run's agent" data-au-run="${run.id}">${cells}</button>`;
      return `<div class="ma-au-hist-row" data-au-run-row>${cells}</div>`;
    };

    const runHistory = (a: Automation) =>
      a.runs.length === 0
        ? `<div class="ma-au-placeholder">No runs yet. Use Run now to try it.</div>`
        : `<div data-au-runs><div class="ma-au-strip" aria-hidden="true">${a.runs
            .map((run) => {
              const s = statusOf(run);
              return `<span class="ma-au-${s.tone}" title="${historyTime(run.firedAt)} · ${s.label}"><span class="ma-au-dot"></span></span>`;
            })
            .join("")}</div><div class="ma-au-hist">${a.runs.map(runRow).join("")}</div></div>`;

    const detailPage = (a: Automation) => {
      const hostName = a.host === "local" ? "This Mac" : REMOTE_HOST;
      const running = busy.has(a);
      const next = a.enabled ? occurrences(a.schedule, new Date(), 3, 1) : [];
      const pane = a.reuse ? `, ${chip("new tab each run")}` : "";
      return (
        `<div class="ma-au-detail" data-au-detail><div class="ma-au-detail-top"><button class="ma-btn ma-ghost ma-sm ma-au-back" type="button" tabindex="-1" data-au-back>‹ Automations</button>` +
        `<div class="ma-au-title-row"><input class="ma-input ma-au-name-input" type="text" tabindex="-1" spellcheck="false" aria-label="Name" value="${esc(a.name)}" data-au-field="name">` +
        `<span class="ma-au-actions"><button class="ma-btn ma-secondary ma-sm" type="button" tabindex="-1" data-run-now${running ? " disabled" : ""}><span class="ma-au-button-icon">${icon("play", 11)}</span>${running ? "Starting…" : "Run now"}</button>` +
        `<label class="ma-au-switch-label" data-au-enabled>${a.enabled ? "On" : "Paused"}<button class="ma-switch" type="button" tabindex="-1" role="switch" aria-checked="${a.enabled}" aria-label="${a.enabled ? "Pause" : "Resume"}" data-state="${a.enabled ? "checked" : "unchecked"}"><span></span></button></label></span></div></div>` +
        `<div class="ma-au-card"><div class="ma-section-label">When and where</div>` +
        `<div class="ma-au-sentence">${chip(describe(a.schedule))} ${esc(zone)} time, start ${chip("Claude")} in ${chip(a.project)} on <span class="ma-au-chip-static" title="An automation stays on the host it was made on">${hostName}</span> with ${chip(a.reuse ? `reuse “${a.reuse}”` : "new workspace")}${pane}</div>` +
        `<div class="ma-au-note ma-au-mono" data-au-next>${cronOf(a.schedule)} · ${next.length ? `next ${next.map(dayAndTime).join(" · ")}` : "— paused"}</div>` +
        `<div class="ma-au-note">${a.host === "local" ? "Runs only while Manor is open on this computer" : `If ${hostName} is asleep at that time, it runs once when it wakes (within ${GRACE_HOURS} h).`}</div></div>` +
        `<div class="ma-au-field"><div class="ma-section-label">Prompt</div><textarea class="ma-input ma-textarea ma-au-prompt" tabindex="-1" aria-label="Prompt" placeholder="What should the agent do each time?" data-au-field="prompt">${esc(a.prompt)}</textarea></div>` +
        `<div class="ma-au-field"><div class="ma-section-label">Runs</div>${runHistory(a)}</div>` +
        `<div class="ma-au-footer"><button class="ma-btn ma-ghost ma-sm ma-au-delete" type="button" tabindex="-1">Delete automation</button><span class="ma-au-note">Changes save as you make them</span></div>` +
        `</div>`
      );
    };

    /** scheduler.ts `runNow`, then fire-run.ts: the workspace, the run recorded, and the agent's first hook after that. */
    const runNow = (a: Automation) => {
      if (busy.has(a)) return;
      const at = new Date();
      busy.add(a);
      ctx.render();
      let target: Ws;
      ctx.later(900, () => {
        target = a.reuse ? workspaces.find((w) => w.id === "lantern-local")! : runWorkspace(a, at);
      });
      ctx.later(1500, () => {
        busy.delete(a);
        unread = true;
        const run: Run = { id: nextRun++, firedAt: at, what: `Run now · ${a.reuse ?? target.name}`, skipped: false, agent: null, gone: false };
        a.runs.unshift(run);
        ctx.later(900, () => {
          run.agent = startAgent(a, target, "thinking");
          shownAgent.set(target.id, run.agent.id);
          const agent = run.agent;
          ctx.later(1600, () => {
            agent.status = "working";
            agent.secs = 1;
            agent.log.push(...toolRows(a));
            ctx.later(2200, () => finish(agent, a));
          });
        });
      });
    };

    const openWorkspace = (id: string, agentId?: string) => {
      ws = id;
      page = null;
      if (agentId) shownAgent.set(id, agentId);
      for (const agent of agents) if (agent.ws === id) agent.unseen = false;
      ctx.render();
    };

    // ---- the window ---------------------------------------------------------

    const wsRow = (w: Ws): WorkspaceRow => {
      const here = agents.filter((a) => a.ws === w.id);
      const loudest = here.find((a) => a.status === "requires_input") ?? here.find((a) => a.status === "working") ?? here.find((a) => a.status === "thinking") ?? here.find((a) => a.unseen) ?? here[0];
      const onScreen = page === null && ws === w.id;
      return {
        id: w.id,
        name: w.name,
        branch: w.branch,
        isMain: w.isMain,
        active: w.id === ws,
        indicator: loudest ? toWorkspaceIndicator({ status: loudest.status, pulse: loudest.unseen && !onScreen }) : null,
      };
    };

    const projectRow = (id: string, color: string, host?: string): ProjectRow => {
      const mine = workspaces.filter((w) => w.project === id);
      const runs = mine.filter((w) => w.inFolder);
      return {
        id,
        name: id,
        color,
        host,
        selected: mine.some((w) => w.id === ws),
        workspaces: mine.filter((w) => !w.inFolder).map(wsRow),
        folders: runs.length ? [{ name: "Automations", workspaces: runs.map(wsRow) }] : [],
      };
    };

    const terminal = (agent: Agent) => {
      const live =
        agent.status === "thinking" || agent.status === "working"
          ? [`<span class="o">${["✶", "✻", "✽", "✻"][tick % 4]} ${agent.status === "thinking" ? "Thinking" : "Composing"}… <span class="d">(${agent.secs}s · esc to interrupt)</span></span>`, ""]
          : [];
      return [...agent.log, ...live, `<span class="d">&gt;</span> ${cursor(page === null)}`].slice(-38).join("\n");
    };

    const panel = () => {
      const open = workspaces.find((w) => w.id === ws)!;
      const here = agents.filter((a) => a.ws === ws);
      const shown = here.find((a) => a.id === shownAgent.get(ws)) ?? (open.isMain ? undefined : here[0]);
      const shell = `<span class="g">➜</span>  <span class="c">${open.project}</span> <span class="b">git:(</span><span class="r">${esc(open.branch)}</span><span class="b">)</span> ${cursor(page === null)}`;
      const tabs = [
        ...(open.isMain ? [{ id: "shell", title: open.branch, active: !shown, status: null, pulse: false }] : []),
        ...here.map((a) => ({ id: a.id, title: a.title, active: a === shown, status: a.status, pulse: false })),
      ];
      return tabbedPanel(
        tabs,
        shown
          ? leafPane({ id: shown.id, title: shown.title, focused: true, hasChat: true, body: terminal(shown) })
          : leafPane({ title: open.project, focused: true, hasChat: false, body: shell }),
      );
    };

    return {
      render: () => {
        const content = root.querySelector<HTMLElement>(".ma-settings-content");
        scrollTop = content?.scrollTop ?? scrollTop;
        const active = document.activeElement as HTMLInputElement | null;
        focusField = active && root.contains(active) && active.dataset.auField ? { name: active.dataset.auField, start: active.selectionStart ?? 0, end: active.selectionEnd ?? 0 } : null;
        const open = workspaces.find((w) => w.id === ws)!;
        const projects = [projectRow("harbor", "cyan"), projectRow("lantern", "magenta", REMOTE_HOST)];
        return {
          projects,
          agentGroups: ["harbor", "lantern"].map((project) => ({
            project,
            agents: agents.filter((a) => a.project === project).map((a) => ({ id: a.id, title: a.title, status: a.status, pulse: a.unseen })),
          })),
          unread,
          crumbs: [open.project, open.name === "local" ? open.branch : open.name],
          main: panel(),
          overlay: page
            ? settingsModal({
                projects: [
                  { id: "harbor", name: "harbor" },
                  { id: "lantern", name: "lantern" },
                ],
                activePage: "Automations",
                projectsOpen,
                content: page === "list" ? listPage() : detailPage(page),
              })
            : undefined,
        };
      },
      drawn: () => {
        const content = root.querySelector<HTMLElement>(".ma-settings-content");
        if (!content) return;
        content.scrollTop = scrollTop;
        // Typed in place: a redraw would take the focus. "Changes save as you make them".
        content.addEventListener("input", (e) => {
          const el = e.target as HTMLInputElement;
          if (typeof page !== "object" || !page) return;
          if (el.dataset.auField === "name") page.name = el.value;
          if (el.dataset.auField === "prompt") page.prompt = el.value;
        });
        if (focusField) {
          const el = content.querySelector<HTMLInputElement>(`[data-au-field="${focusField.name}"]`);
          el?.focus({ preventScroll: true });
          el?.setSelectionRange(focusField.start, focusField.end);
        }
        if (clicked) keepKeysInSettings(root);
      },
      onClick: (e) => {
        const t = e.target as Element | null;
        if (!t || !root.contains(t)) return;
        clicked = true;
        const hit = (selector: string) => t.closest<HTMLElement>(selector);
        if (hit("[data-close-settings]")) {
          page = null;
          return ctx.render();
        }
        if (hit("[data-nav-projects]")) {
          projectsOpen = !projectsOpen;
          return ctx.render();
        }
        const opened = list.find((a) => a.id === hit("[data-au-open]")?.dataset.auOpen);
        if (opened) {
          page = opened;
          scrollTop = 0;
          return ctx.render();
        }
        if (hit("[data-au-back]")) {
          page = "list";
          scrollTop = 0;
          return ctx.render();
        }
        if (typeof page === "object" && page) {
          if (hit("[data-run-now]")) return runNow(page);
          if (hit("[data-au-enabled]")) {
            page.enabled = !page.enabled;
            return ctx.render();
          }
          const run = page.runs.find((r) => String(r.id) === hit("[data-au-run]")?.dataset.auRun);
          if (run?.agent) return openWorkspace(run.agent.ws, run.agent.id);
        }
        // The window behind, once Settings is shut. The gear stands in for the app's other ways back to this page.
        if (hit('[aria-label="Project Settings"]')) {
          page = "list";
          scrollTop = 0;
          return ctx.render();
        }
        if (hit(".ma-project-actions")) return;
        const agent = agents.find((a) => a.id === hit("[data-agent]")?.dataset.agent);
        if (agent) return openWorkspace(agent.ws, agent.id);
        const wsId = hit("[data-ws]")?.dataset.ws;
        if (wsId) return openWorkspace(wsId);
        const tabId = hit("[data-tab]")?.dataset.tab;
        if (tabId && !hit(".ma-tab-close") && page === null) {
          shownAgent.set(ws, tabId);
          ctx.render();
        }
      },
      onKey: (e) => {
        if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || page === null) return;
        const target = e.target as Element | null;
        if (!target || !root.contains(target)) return;
        e.preventDefault();
        page = null;
        ctx.render();
      },
      // On Settings, re-laid out to fit (automations.css), or the sidebar that's the way around.
      phoneCrop: () => (page ? { x: 358, y: 24 } : { x: 0, y: 24 }),
      // The open agent's spinner, in its own pane, while Settings is shut.
      onFrame: ({ ms }) => {
        if (!agents.some((a) => a.status === "thinking" || a.status === "working")) return;
        sinceTick += ms;
        if (sinceTick < TICK_MS) return;
        sinceTick %= TICK_MS;
        tick++;
        for (const agent of agents) {
          if (agent.status !== "thinking" && agent.status !== "working") continue;
          if (tick % 4 === 0) agent.secs++;
          const term = root.querySelector(`[data-pane="${agent.id}"] .ma-term`);
          if (term) term.innerHTML = terminal(agent);
        }
      },
    };
  },
};
