// Remote hosts: an agent on `build-box`, in a pane on the desk, has asked a question. It's
// the same question on a phone beside the desk, as QuestionCard draws it; an answer from
// either ends it on both, and the phone never resizes the desk.
import "./remote-hosts.css";
import { esc, leafPane, tabbedPanel } from "../../shell/chrome";
import { icon } from "../../shell/icons";
import { TICK_MS } from "../../shell/render";
import { toWorkspaceIndicator, type AgentStatus } from "../../shell/state";
import { claudeBox, cursor, wrapped } from "../../shell/terminals";
import type { Slide } from "../slide";

const AGENT = "Backfill tide records";
const OTHER_AGENT = "Round dock fees";
const WORKSPACE = "tide-import";
const PROMPT = "Backfill the old tide records into the new heights table";
const LEAD_IN = "412,806 rows to move. Before I start, one question.";
const HEADER = "Backfill";
const QUESTION = "How should I backfill the old tide records?";
const COMMAND = "pnpm db:backfill --dry-run";
const TERMINAL_COLUMNS = 80;

/** ChatThinking's `SHOW_AFTER_MS`: a shorter silence shows nothing. */
const THINKING_SHOWS_AFTER_MS = 600;
/** The time QuestionCard's note stays up here, for the answer's trip to the host and back. */
const ANSWER_TRIP_MS = 1000;
const LONGEST_VERB = "Cataloguing…";

const OPTIONS = [
  { label: "In batches overnight", description: "Slower, but the table stays readable", reply: "The batches are set up and the dry run is clean. It'll go overnight and the table stays readable." },
  { label: "All at once", description: "About ten minutes with the table locked", reply: "The dry run is clean. The full run takes about ten minutes, with the table locked while it goes." },
  { label: "Only this year's", description: "Older records stay as they are for now", reply: "This year's records are ready to move and the dry run is clean. Older ones stay as they are." },
] as const;

const OTHER_REPLY = "I'll do it that way, and the dry run is clean.";

/** Rows the transcript had before the question: a Claude Code session, printed. */
const OPENING: readonly string[] = [
  ...claudeBox("~/harbor/tide-import"),
  `<span class="d">&gt;</span> ${PROMPT}`,
  "",
  '<span class="g">●</span> Read(<b>scripts/backfill-tides.ts</b>)',
  '  <span class="d">⎿  Read 64 lines</span>',
  "",
  "<span class=\"g\">●</span> Bash(<b>psql -c 'select count(*) from tide_records'</b>)",
  '  <span class="d">⎿  412806</span>',
  "",
  `<span class="g">●</span> ${LEAD_IN}`,
  "",
];

/** Claude Code's AskUserQuestion menu. The options are real buttons; its "Type something." takes keys, which the terminal here doesn't. */
const terminalQuestion = () =>
  [
    `<span class="d">${"─".repeat(140)}</span>`,
    ` <span class="b">☐ ${HEADER}</span>`,
    "",
    `<b>${QUESTION}</b>`,
    "",
    `<span class="ma-rh-opts">${OPTIONS.map(
      (o, i) =>
        `<button class="ma-rh-opt${i === 0 ? " sel" : ""}" type="button" tabindex="-1" data-answer="${i}"><span class="ma-rh-ptr">❯</span> ${i + 1}. ${o.label}\n     <span class="d">${o.description}</span></button>`,
    ).join("\n")}</span>`,
    `  ${OPTIONS.length + 1}. Type something.`,
    "",
    '<span class="d">Enter to select · ↑/↓ to navigate · Esc to cancel</span>',
  ].join("\n");

/** The chat's transcript so far, each entry's HTML under its own id. */
type Entry = { id: string; html: string };

const userBubble = (text: string) => `<div class="ma-ch-user-row"><div class="ma-ch-user">${esc(text)}</div></div>`;
const assistant = (html: string) => `<div class="ma-ch-assistant">${html}</div>`;

/** ChatEntryView's ToolGroupView, with `leading` the running call's dot, or nothing. */
const toolGroup = (leading: string, summary: string, trailing = "") =>
  `<div class="ma-ch-tools"><button class="ma-btn ma-ghost ma-sm ma-ch-tools-line" type="button" tabindex="-1">${leading}<span class="ma-ch-tools-summary">${summary}</span>${trailing}<span class="ma-ch-chevron">${icon("chevron-right", 14)}</span></button></div>`;

/** DustMark: three motes of dust. */
const dust = (live: boolean) =>
  `<svg class="ma-ch-dust"${live ? " data-live" : ""} viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><circle cx="3.2" cy="9" r="1.15"/><circle cx="7.4" cy="7" r="1.15"/><circle cx="11" cy="9.6" r="1.15"/></svg>`;

/** ChatEntryView's TurnEnd. */
const turnEnd = (verb: string, time: string) =>
  `<div class="ma-ch-turn-end">${dust(false)}<span><span class="ma-ch-turn-phrase"><span class="ma-ch-turn-verb">${verb}</span> for <span class="ma-ch-turn-time">${time}</span></span></span></div>`;

/** ChatTypewriter: a reply that arrives whole, typed out a word at a time at its `MIN_CPS`, or within its `MAX_TYPING_MS`. */
function typedOut(text: string): string {
  const perChar = Math.min(5, 1000 / text.length);
  let at = 0;
  return text
    .split(" ")
    .map((word) => {
      const html = `<span class="ma-ch-word" style="animation-delay: ${Math.round(at * perChar)}ms">${esc(word)}</span>`;
      at += word.length + 1;
      return html;
    })
    .join(" ");
}

export const remoteHosts: Slide = {
  id: "remote-hosts",
  label: "Remote hosts",
  title: "Your agents don't live on your laptop.",
  description: "Run them on any machine you can SSH into, then answer from your desk or your phone.",
  hint: "Tap an answer on the phone.",
  alt: "An interactive mock of Manor beside a phone: a project's workspaces grouped by host, this machine, build-box and a sleeping spare-box; an agent on build-box asking a question in its terminal on the desk, and the same question as a card on the phone.",
  enter(ctx) {
    const { root } = ctx;

    let status: AgentStatus = "requires_input";
    /** The agent on this machine, off screen: on-screen agents are marked seen as they change, so this is the one that can light the bell. */
    let otherStatus: AgentStatus = "working";
    let unread = false;

    /** The question is open, its answer on its way, or answered. */
    let phase: "open" | "sent" | "answered" = "open";
    let chosen: number | null = null;
    /** The "Other…" text, or null while Other isn't chosen, as a QuestionSelection has it. */
    let other: string | null = null;
    let otherFocused = false;
    let caret = 0;

    let thinkingShown = false;
    let verb = "Tending";
    let toolRunning = false;

    let tick = 0;
    let sinceTick = 0;
    let secs = 0;

    const log: string[] = [...OPENING];
    /** The phone's entries after the question. */
    const after: Entry[] = [];
    /** What's been drawn: an entry rises in once, not on every redraw. */
    const drawn = new Set<string>(["prompt", "read", "lead-in", "question"]);

    const busy = () => status === "thinking" || status === "working";

    const terminal = () => {
      if (phase !== "answered") return [...log, terminalQuestion()].join("\n");
      const live = busy()
        ? [`<span class="o">${["✶", "✻", "✽", "✻"][tick % 4]} ${status === "thinking" ? "Thinking" : "Composing"}… <span class="d">(${secs}s · esc to interrupt)</span></span>`, ""]
        : [];
      return [...log, ...live, `<span class="d">&gt;</span> ${cursor(true)}`].join("\n");
    };

    /** QuestionCard, whose buttons all go quiet once an answer is sent. */
    const questionCard = () => {
      const disabled = phase !== "open" ? " disabled" : "";
      const options = OPTIONS.map((o, i) => {
        const isChosen = chosen === i;
        return (
          `<button class="ma-btn ${isChosen ? "ma-primary" : "ma-secondary"} ma-ch-option" type="button" tabindex="-1" data-chosen="${isChosen}"${disabled} data-answer="${i}">` +
          `<span class="ma-ch-option-label">${o.label}</span><span class="ma-ch-option-description">${o.description}</span></button>`
        );
      }).join("");
      const otherOn = other !== null;
      const otherButton =
        `<button class="ma-btn ${otherOn ? "ma-primary" : "ma-secondary"} ma-ch-option" type="button" tabindex="-1" data-chosen="${otherOn}" aria-pressed="${otherOn}"${disabled} data-other>` +
        `<span class="ma-ch-option-label">Other…</span></button>`;
      const input = otherOn
        ? `<input class="ma-ch-other" type="text" tabindex="-1" maxlength="80" value="${esc(other!)}" placeholder="Your answer" aria-label="Your answer"${disabled} data-other-input>`
        : "";
      const footer =
        phase !== "open"
          ? `<div class="ma-ch-card-note">Answer sent, waiting for Claude…</div>`
          : otherOn
            ? `<button class="ma-btn ma-primary ma-ch-submit" type="button" tabindex="-1"${other!.trim() ? "" : " disabled"} data-submit>Submit</button>`
            : "";
      return (
        `<div class="ma-ch-card" data-question><div class="ma-ch-question"><div class="ma-ch-card-header">${HEADER}</div>` +
        `<div class="ma-ch-question-text">${QUESTION}</div>` +
        `<div class="ma-ch-options" role="group" aria-label="${HEADER}">${options}${otherButton}${input}</div></div>${footer}</div>`
      );
    };

    const answeredLine = () =>
      `<div class="ma-ch-answered" data-answered><span class="ma-ch-answered-title">${HEADER}</span><span class="ma-ch-answered-value">${esc(answerText())}</span></div>`;

    const answerText = () => (chosen !== null ? OPTIONS[chosen]!.label : (other ?? "").trim());

    const entries = (): Entry[] => [
      { id: "prompt", html: userBubble(PROMPT) },
      { id: "read", html: toolGroup("", "Read a file, ran a command") },
      { id: "lead-in", html: assistant(esc(LEAD_IN)) },
      { id: "question", html: phase === "answered" ? answeredLine() : questionCard() },
      ...after,
    ];

    /** ChatPane's `thinking`: the turn's running with no call in progress and nothing else to show. */
    const thinkingLine = () =>
      busy() && !toolRunning && thinkingShown
        ? `<div class="ma-ch-thinking" role="status" data-thinking>${dust(true)}<span class="ma-ch-thinking-slot" data-longest="${LONGEST_VERB}"><span class="ma-ch-thinking-verb">${verb}…</span></span><span class="ma-ch-elapsed" data-elapsed>${secs}s</span></div>`
        : "";

    const runningTool = () =>
      busy() && toolRunning
        ? `<div class="ma-ch-entry">${toolGroup('<span class="ma-ch-pending" role="img" aria-label="running"></span>', COMMAND, `<span class="ma-ch-elapsed" data-elapsed>${secs}s</span>`)}</div>`
        : "";

    const chatEntries = () =>
      entries()
        .map((e) => {
          const fresh = !drawn.has(e.id);
          drawn.add(e.id);
          return `<div class="ma-ch-entry"${fresh ? " data-enter" : ""} data-entry="${e.id}">${e.html}</div>`;
        })
        .join("") +
      runningTool() +
      thinkingLine();

    /** ChatComposer: Stop while the agent works, else Send, which has nothing to send. */
    const composer = () =>
      `<div class="ma-ch-composer"><div class="ma-ch-field"><button class="ma-btn ma-ghost ma-ch-attach" type="button" tabindex="-1" aria-label="Attach image">${icon("image-plus", 18)}</button>` +
      `<textarea class="ma-ch-input" tabindex="-1" rows="1" readonly placeholder="Type / for commands" aria-label="Message Claude"></textarea>` +
      (busy()
        ? `<button class="ma-btn ma-primary ma-ch-send ma-ch-stop" type="button" tabindex="-1" aria-label="Stop Claude" data-stop>${icon("square", 12)}</button>`
        : `<button class="ma-btn ma-primary ma-ch-send" type="button" tabindex="-1" aria-label="Send message" disabled data-send>${icon("arrow-up", 16)}</button>`) +
      `</div><div class="ma-ch-status"><div class="ma-ch-chips"><button class="ma-ch-chip" type="button" tabindex="-1" aria-label="Branch ${WORKSPACE}">${icon("git-branch", 11)}<span>${WORKSPACE}</span></button>` +
      `<span class="ma-ch-chip ma-ch-chip-plain">Opus 5.5</span></div><span class="ma-ch-tokens">38k</span></div></div>`;

    /** PhoneTopBar over LeafPanel's tab strip over ChatPane, in a device that isn't Manor's. */
    const phone = () =>
      `<div class="ma-ph-device" data-phone><div class="ma-ph-screen"><div class="ma-ph">` +
      `<div class="ma-ph-top"><button class="ma-btn ma-ghost ma-ph-icon" type="button" tabindex="-1" aria-label="Open sidebar">${icon("panel-left", 18)}</button>` +
      `<div class="ma-ph-name">${WORKSPACE}</div>` +
      `<div><button class="ma-btn ma-ghost ma-ph-icon" type="button" tabindex="-1" aria-label="More">${icon("ellipsis-vertical", 18)}</button></div></div>` +
      tabbedPanel(
        [{ id: "phone", title: AGENT, active: true, status, pulse: false }],
        `<div class="ma-ch"><div class="ma-ch-scroller"><div class="ma-ch-entries">${chatEntries()}</div></div>${composer()}</div>`,
      ) +
      `</div></div></div>`;

    /** The answer lands: the menu closes on the desk, the card folds on the phone, and the turn runs on. */
    const land = () => {
      const answer = answerText();
      const reply = chosen !== null ? OPTIONS[chosen]!.reply : OTHER_REPLY;
      phase = "answered";
      status = "thinking";
      secs = 0;
      log.push(
        '<span class="g">●</span> User answered Claude\'s questions:',
        ...wrapped(`· ${QUESTION} → ${answer}`, '  <span class="d">⎿</span>  ', "     ", TERMINAL_COLUMNS),
        "",
      );
      ctx.render();
      ctx.later(THINKING_SHOWS_AFTER_MS, () => {
        thinkingShown = true;
      });
      ctx.later(1600, () => {
        status = "working";
        toolRunning = true;
        secs = 0;
        log.push(`<span class="g">●</span> Bash(<b>${COMMAND}</b>)`, '  <span class="d">⎿  Running…</span>');
      });
      ctx.later(3200, () => {
        toolRunning = false;
        verb = "Polishing";
        secs = 0;
        log.pop();
        log.push('  <span class="d">⎿  Dry run finished with no errors</span>', "");
        after.push({ id: "dry-run", html: toolGroup("", "Ran a command") });
      });
      ctx.later(4300, () => {
        status = "responded";
        log.push(...wrapped(reply, '<span class="g">●</span> ', "  ", TERMINAL_COLUMNS), "");
        after.push({ id: "reply", html: assistant(typedOut(reply)) }, { id: "turn-end", html: turnEnd("Polished", "1m 12s") });
      });
      ctx.later(5000, () => {
        otherStatus = "responded";
        unread = true;
        // This redraw mustn't type the reply out again.
        after.find((e) => e.id === "reply")!.html = assistant(esc(reply));
      });
    };

    /** useSendAnswer, from the phone: the note, then the transcript's word that it landed. */
    const sendFromPhone = () => {
      phase = "sent";
      ctx.render();
      ctx.hold(ANSWER_TRIP_MS, land);
    };

    const submitOther = () => {
      if (phase !== "open" || !other?.trim()) return;
      chosen = null;
      sendFromPhone();
    };

    return {
      render: () => {
        const input = root.querySelector<HTMLInputElement>("[data-other-input]");
        if (input) {
          otherFocused = document.activeElement === input;
          caret = input.selectionStart ?? input.value.length;
        }
        return {
          projects: [
            {
              id: "harbor",
              name: "harbor",
              color: "cyan",
              selected: true,
              workspaces: [],
              sections: [
                {
                  host: "This machine",
                  state: "local",
                  workspaces: [
                    { id: "harbor-local", name: "local", branch: "main", isMain: true, active: false, indicator: null },
                    { id: "dock-fees", name: "dock-fees", branch: "dock-fees", isMain: false, active: false, indicator: toWorkspaceIndicator({ status: otherStatus, pulse: otherStatus === "responded" }) },
                  ],
                },
                {
                  host: "build-box",
                  state: "connected",
                  workspaces: [
                    { id: WORKSPACE, name: WORKSPACE, branch: WORKSPACE, isMain: false, active: true, indicator: toWorkspaceIndicator({ status, pulse: false }) },
                    { id: "gauge-sweep", name: "gauge-sweep", branch: "gauge-sweep", isMain: false, active: false, indicator: null },
                  ],
                },
                {
                  host: "spare-box",
                  state: "asleep",
                  workspaces: [{ id: "chart-cache", name: "chart-cache", branch: "chart-cache", isMain: false, active: false, indicator: null }],
                },
              ],
            },
          ],
          agentGroups: [
            {
              project: "harbor",
              agents: [
                { id: "agent", title: AGENT, status, pulse: false },
                { id: "other", title: OTHER_AGENT, status: otherStatus, pulse: otherStatus === "responded" },
              ],
            },
          ],
          host: "build-box",
          unread,
          crumbs: ["harbor", WORKSPACE],
          main: tabbedPanel(
            [{ id: WORKSPACE, title: AGENT, active: true, status, pulse: false }],
            leafPane({ id: "agent", title: AGENT, focused: true, hasChat: true, body: terminal() }),
          ),
          overlay: phone(),
        };
      },
      drawn: () => {
        const input = root.querySelector<HTMLInputElement>("[data-other-input]");
        if (!input) return;
        input.addEventListener("input", () => {
          other = input.value;
          root.querySelector<HTMLButtonElement>("[data-submit]")!.disabled = !input.value.trim();
        });
        if (otherFocused) {
          input.focus({ preventScroll: true });
          input.setSelectionRange(caret, caret);
        }
      },
      onClick: (e) => {
        const t = e.target as Element | null;
        if (!t || !root.contains(t) || phase !== "open") return;
        const hit = (selector: string) => t.closest<HTMLElement>(selector);
        const option = hit("[data-answer]");
        if (option) {
          // QuestionCard's `answersOnTap`: one single-select question, so the tap is the answer.
          chosen = Number(option.dataset.answer);
          other = null;
          // In the desk's own terminal the keys go straight to Claude; the phone only hears when the transcript does.
          if (hit("[data-phone]")) sendFromPhone();
          else land();
          return;
        }
        if (hit("[data-other]")) {
          // `chooseOther`, and the input's `autoFocus`.
          other ??= "";
          otherFocused = true;
          caret = other.length;
          ctx.render();
          return;
        }
        if (hit("[data-submit]")) submitOther();
      },
      onKey: (e) => {
        if (e.key !== "Enter" || e.target !== root.querySelector("[data-other-input]")) return;
        e.preventDefault();
        submitOther();
      },
      // The spinner and timers, in place: a redraw would restart the marks' animations.
      onFrame: ({ ms }) => {
        if (!busy()) return;
        sinceTick += ms;
        if (sinceTick < TICK_MS) return;
        sinceTick %= TICK_MS;
        tick++;
        if (tick % 4 === 0) secs++;
        const term = root.querySelector('[data-pane="agent"] .ma-term');
        if (term) term.innerHTML = terminal();
        const elapsed = root.querySelector("[data-elapsed]");
        if (elapsed) elapsed.textContent = `${secs}s`;
      },
    };
  },
};
