// Review: an agent's terminal beside a file pane on a changed file's diff. Comment on a
// changed line and Send takes the comments to the agent, as FilePane and ReviewSend do it.
import "./review.css";
import { esc, leafPane, splitPanes, tabbedPanel } from "../../shell/chrome";
import { icon } from "../../shell/icons";
import { toWorkspaceIndicator, type AgentStatus } from "../../shell/state";
import { TICK_MS } from "../../shell/render";
import { claudeBox, cursor, wrapped } from "../../shell/terminals";
import { createToasts } from "../../shell/toasts";
import type { Slide } from "../slide";

const AGENT = "Tide heights";
const FILE_PATH = "src/tides/TideRow.tsx";
const FILE_NAME = "TideRow.tsx";
/** The pane's width after a drag of the split's divider: even, the diff wouldn't fit beside the 240px drawer. */
const AGENT_PANE_PERCENT = 36;
/** lib/review-submit.ts's toast id, for this workspace: a second send replaces the toast. */
const TOAST_ID = "review-submit-~/harbor/tide-tables";
/** useReviewSend's `CONFIRM_TIMEOUT`. */
const DISCARD_CONFIRM_MS = 4000;
/** Word-wrapped columns of the agent's prompt, in that width. */
const TERMINAL_COLUMNS = 44;
/** On a phone, how long the agent's reply stays in view before the crop goes back to the diff. */
const REPLY_READ_MS = 2500;

/** Written by hand as Lezer would tag it, for editor-theme.ts's `syntax`: «classes|text». `x` is cm-changedText. */
const source = (line: string) =>
  line
    .split(/(«[a-z]+\|[^»]*»)/)
    .map((part) => {
      const token = /^«([a-z]+)\|([^»]*)»$/.exec(part);
      if (!token) return esc(part);
      return `<span class="${[...token[1]!].map((c) => `t-${c}`).join(" ")}">${esc(token[2]!)}</span>`;
    })
    .join("");

type Changed = {
  line: number;
  text: string;
  /** The comment ready in the composer, for the visitor to send or change. */
  prefill: string;
  /** What the agent says about the prefilled comment. */
  reply: string;
  /** The rows `snippetFor` quotes: the removed line it takes in, then its own. */
  snippet: string;
};

const CHANGED: readonly Changed[] = [
  {
    line: 8,
    text: "  «k|const» «x|feet» «p|=» level «px|*» «nx|3.28»«p|;»",
    prefill: "Round this to one decimal, like the rest of the table.",
    reply: "Rounded feet to one decimal.",
    snippet: "8: -  const height = level / 100;\n8: +  const feet = level * 3.28;",
  },
  {
    line: 9,
    text: "  «kx|const» «x|label» «px|=» «fx|formatFeet»«px|(»«x|feet»«px|);»",
    prefill: "Does formatFeet still expect metres?",
    reply: "formatFeet takes feet, so that line is right as it is.",
    snippet: "9: +  const label = formatFeet(feet);",
  },
];

/** `snippetFor`'s rows once the agent has rounded line 8, and what it says when asked again. */
const LINE_8_ROUNDED_SNIPPET = "8: -  const height = level / 100;\n8: +  const feet = +(level * 3.28).toFixed(1);";
const ALREADY_ROUNDED_REPLY = "Feet are already rounded to one decimal, so that line stays as it is.";

const LINE_8_ROUNDED = "  «k|const» «x|feet» «p|=» «px|+(»level «px|*» «nx|3.28»«px|).»«fx|toFixed»«px|(»«nx|1»«px|);»";
const DELETED = "  «k|const» «x|height» «p|=» level «px|/» «nx|100»«p|;»";

/** The unchanged lines the diff's folds leave showing: collapseUnchanged `margin: 3`. */
const LEADING: readonly [number, string, boolean?][] = [
  [5, "«k|export» «k|function» «f|TideRow»«p|({» port «p|}:» «f|Props»«p|)» «p|{»", true],
  [6, "  «k|const» level «p|=» «f|useTide»«p|(»port«p|);»"],
  [7, "  «k|if» «p|(»level «p|==» «k|null»«p|)» «k|return» «k|null»«p|;»"],
];
const TRAILING: readonly [number, string, boolean?][] = [
  [10, "  «k|return» «p|(»", true],
  [11, "    «p|<»«k|li» «a|className»«p|=»«s|\"tide-row\"»«p|>»", true],
  [12, "      «p|<»«k|b»«p|>{»port«p|}</»«k|b»«p|>» «p|{»label«p|}»"],
];

type Comment = { id: number; line: number; body: string };
/** `initial`: what it opened with, which says whether it holds edits worth keeping. */
type Composing = { line: number; body: string; initial: string; editing: Comment | null };

const countLabel = (n: number) => (n === 1 ? "1 comment" : `${n} comments`);
const changedAt = (line: number) => CHANGED.find((c) => c.line === line)!;

/** lib/review-submit.ts `reviewPrompt` through lib/agent-command.ts `flattenPrompt`, with the app's default text. */
function flatPrompt(comments: readonly Comment[], rounded: boolean): string {
  const snippet = (line: number) => (line === 8 && rounded ? LINE_8_ROUNDED_SNIPPET : changedAt(line).snippet);
  const lines = comments.flatMap((c, i) => [`[${i + 1}] ${FILE_PATH} L${c.line} — ${c.body.trim()}`, `    Code: ${snippet(c.line)}`]);
  const prompt = [
    `I left ${countLabel(comments.length)} on the current diff. Take each on its own terms — it may be a question about the code rather than a request to change it. Answer questions directly, and only edit code where a comment actually asks for that.`,
    ...lines,
  ].join("\n");
  return prompt.replace(/\s*[\r\n]\s*/g, " ").trim();
}

const toggle = (view: "local" | "branch") =>
  `<div class="ma-toggle" role="radiogroup" aria-label="Source Control view">` +
  (
    [
      ["local", "Local"],
      ["branch", "Branch"],
    ] as const
  )
    .map(([value, label]) => `<button class="ma-toggle-btn${view === value ? " ma-toggle-active" : ""}" type="button" tabindex="-1" data-scm-view="${value}">${label}</button>`)
    .join("") +
  `</div>`;

const iconButton = (label: string, content: string, danger = false) =>
  `<button class="ma-sc-icon-btn${danger ? " ma-sc-danger" : ""}" type="button" tabindex="-1" aria-label="${label}">${content}</button>`;

/** SourceControl's ScmRow, at depth 1 under `src/tides`: `rowIndent` is 6 + 12 + 16. */
function fileRow(name: string, selected: boolean, group: "changes" | "branch"): string {
  const actions =
    iconButton("Open file", icon("file-code", 13)) +
    (group === "changes" ? iconButton("Discard changes", icon("undo-2", 13), true) + iconButton("Stage", icon("plus", 13)) : "");
  return (
    `<div class="ma-sc-row ma-sc-letter-M${selected ? " ma-sc-row-selected" : ""}">` +
    `<button class="ma-sc-row-main" type="button" tabindex="-1" style="padding-left: 34px" title="src/tides/${name}">` +
    `<span class="ma-sc-file-icon">${icon("code-xml", 12)}</span><span class="ma-sc-name">${name}</span></button>` +
    `<span class="ma-sc-actions">${actions}</span><span class="ma-sc-letter">M</span></div>`
  );
}

/** SourceControl's list: Local's CommitBox and `Changes`, or Branch's `Changes vs main`. */
function sourceControl(view: "local" | "branch"): string {
  const commit =
    `<div class="ma-cb"><textarea class="ma-cb-message" tabindex="-1" rows="1" spellcheck="false" placeholder="Message (⌘↵ to commit)" aria-label="Commit message"></textarea>` +
    `<div class="ma-cb-split"><button class="ma-btn ma-primary ma-sm ma-cb-commit" type="button" tabindex="-1" aria-disabled="true">${icon("check", 13)}Commit</button>` +
    `<button class="ma-btn ma-primary ma-sm ma-cb-caret" type="button" tabindex="-1" aria-label="More commit actions">${icon("chevron-down", 13)}</button></div></div>`;
  const group = view === "local" ? "changes" : "branch";
  return (
    `<div class="ma-sc-list">${view === "local" ? commit : ""}<div>` +
    `<div class="ma-sc-group-head"><button class="ma-sc-group-toggle" type="button" tabindex="-1"><span class="ma-sc-chevron">${icon("chevron-down", 12)}</span>` +
    `<span class="ma-sc-group-label">${view === "local" ? "Changes" : "Changes vs main"}</span><span class="ma-sc-group-count">2</span></button>` +
    (view === "local" ? `<span class="ma-sc-actions">${iconButton("Stage all", icon("plus", 13))}</span>` : "") +
    `</div>` +
    `<div class="ma-sc-row"><button class="ma-sc-row-main" type="button" tabindex="-1" style="padding-left: 6px; gap: 4px" title="src/tides"><span class="ma-sc-chevron">${icon("chevron-down", 12)}</span>` +
    `<span class="ma-sc-file-icon">${icon("folder-open", 12)}</span><span class="ma-sc-dir-name">src/tides</span></button></div>` +
    fileRow(FILE_NAME, true, group) +
    fileRow("format.ts", false, group) +
    `</div></div>`
  );
}

const sendSplit = () =>
  `<span class="ma-rs-split"><button class="ma-btn ma-primary ma-sm ma-rs-submit" type="button" tabindex="-1" data-send>Send to ${AGENT}</button>` +
  `<button class="ma-btn ma-primary ma-sm ma-rs-caret" type="button" tabindex="-1" aria-label="Choose where to send this review">${icon("chevron-up", 12)}</button></span>`;

export const review: Slide = {
  id: "review",
  label: "Review",
  title: "Review without leaving the room.",
  description: "Comment on a line of the diff and send it straight back to the agent.",
  hint: "Add a comment on a changed line, then send it.",
  alt: "An interactive mock of Manor: an agent's terminal beside a file pane showing Source Control and a unified diff of a changed file, with a Comment button on a changed line.",
  enter(ctx) {
    const { root } = ctx;
    const toasts = createToasts(root, ctx.hold);

    let view: "local" | "branch" = "local";
    let focus: "agent" | "file" = "file";
    /** The changed line that's selected, with the chip on it. */
    let selected: number | null = CHANGED[0]!.line;
    let composing: Composing | null = null;
    let comments: Comment[] = [];
    let nextComment = 0;
    let rounded = false;
    let composerFocused = false;
    let confirmingDiscard = false;
    let discardPress = 0;
    let caret = 0;

    let status: AgentStatus = "responded";
    let tick = 0;
    let sinceTick = 0;
    let secs = 0;
    let run = 0;
    /** A phone is looking at the agent: from a send until its reply has been read. */
    let watchingAgent = false;
    const log: string[] = [
      ...claudeBox("~/harbor/tide-tables"),
      '<span class="d">&gt;</span> Show tide heights in feet on the table',
      "",
      `<span class="g">●</span> Update(<b>${FILE_PATH}</b>)`,
      '  <span class="d">⎿  Updated with 2 additions and 1 removal</span>',
      "",
      '<span class="g">●</span> Update(<b>src/tides/format.ts</b>)',
      '  <span class="d">⎿  Updated with 3 additions and 3 removals</span>',
      "",
      '<span class="g">●</span> The table now reads in feet. Have a look',
      "  at the diff.",
      "",
    ];

    const terminal = () => {
      const focused = focus === "agent";
      const live =
        status === "thinking" || status === "working"
          ? [`<span class="o">${["✶", "✻", "✽", "✻"][tick % 4]} ${status === "thinking" ? "Thinking" : "Composing"}… <span class="d">(${secs}s · esc to interrupt)</span></span>`, ""]
          : [];
      return [...log, ...live, `<span class="d">&gt;</span> ${cursor(focused)}`].slice(-38).join("\n");
    };

    /** A line of the diff, its marks and whichever of the chip, card and composer hang off it. */
    const row = (n: number, text: string, kind: "plain" | "changed", foldable?: boolean) => {
      const commented = comments.some((c) => c.line === n) || composing?.line === n;
      const isSelected = selected === n && !composing;
      const classes = ["ma-cm-row", kind === "changed" ? "ma-cm-changed" : "", commented ? "ma-cm-commented" : "", isSelected ? "ma-cm-selected" : ""].filter(Boolean).join(" ");
      return (
        `<div class="${classes}"${kind === "changed" ? ` data-line="${n}"` : ""}>` +
        `<div class="ma-cm-num">${n}</div><div class="ma-cm-fold">${foldable ? "⌄" : ""}</div><div class="ma-cm-change"></div>` +
        `<div class="ma-cm-text"><span class="ma-cm-sel">${source(text)}</span><span class="ma-cm-chip-anchor">${isSelected ? chip : ""}</span></div></div>`
      );
    };

    const chip = `<button class="ma-cm-chip" type="button" tabindex="-1" data-comment-chip>+ Comment</button>`;

    const composer = (c: Composing) =>
      `<div class="ma-cm-comment"><div class="ma-cm-comment-inner"><div class="ma-dc"><div class="ma-dc-header"><span class="ma-dc-anchor">L${c.line}</span></div>` +
      `<textarea class="ma-dc-textarea" tabindex="-1" spellcheck="true" placeholder="Leave a comment…" data-composer>${esc(c.body)}</textarea>` +
      `<div class="ma-dc-footer"><button class="ma-btn ma-ghost ma-sm" type="button" tabindex="-1" data-cancel>Cancel</button>` +
      `<button class="ma-btn ma-primary ma-sm" type="button" tabindex="-1" data-add${c.body.trim() ? "" : " disabled"}>Add comment</button></div></div></div></div>`;

    const card = (c: Comment) =>
      `<div class="ma-cm-comment"><div class="ma-cm-comment-inner"><div class="ma-dc" data-comment="${c.id}"><div class="ma-dc-header"><span class="ma-dc-anchor">You · L${c.line}</span>` +
      `<span class="ma-dc-actions"><button class="ma-btn ma-ghost ma-sm ma-dc-action" type="button" tabindex="-1" aria-label="Edit comment" data-edit>${icon("pencil", 12)}</button>` +
      `<button class="ma-btn ma-ghost ma-sm ma-dc-action" type="button" tabindex="-1" aria-label="Delete comment" data-delete>${icon("trash-2", 12)}</button></span></div>` +
      `<div class="ma-dc-body">${esc(c.body)}</div></div></div></div>`;

    const hanging = (n: number) =>
      comments
        .filter((c) => c.line === n && composing?.editing !== c)
        .map(card)
        .join("") + (composing?.line === n ? composer(composing) : "");

    const collapsed = (n: number) => `<div class="ma-cm-collapsed"><div class="ma-cm-collapsed-text">${n} unchanged lines</div></div>`;

    const diff = () =>
      `<div class="ma-cm-frame"><div class="ma-cm" data-diff>` +
      collapsed(4) +
      LEADING.map(([n, text, fold]) => row(n, text, "plain", fold)).join("") +
      `<div class="ma-cm-row ma-cm-deleted"><div class="ma-cm-num"></div><div class="ma-cm-fold"></div><div class="ma-cm-change"></div><div class="ma-cm-text">${source(DELETED)}</div></div>` +
      CHANGED.map((c) => row(c.line, c.line === 8 && rounded ? LINE_8_ROUNDED : c.text, "changed") + hanging(c.line)).join("") +
      TRAILING.map(([n, text, fold]) => row(n, text, "plain", fold)).join("") +
      collapsed(4) +
      `</div><div class="ma-cm-lane"></div></div>`;

    /** ReviewSection: only there while there are drafts. */
    const reviewSection = () =>
      comments.length === 0
        ? ""
        : `<div class="ma-sc-review"><div class="ma-sc-group-head"><button class="ma-sc-group-toggle" type="button" tabindex="-1"><span class="ma-sc-chevron">${icon("chevron-down", 12)}</span>` +
          `<span class="ma-sc-group-label">Review comments</span><span class="ma-sc-group-count">${comments.length}</span></button></div>` +
          `<div class="ma-sc-review-list">${comments
            .map(
              (c) =>
                `<button class="ma-sc-review-item" type="button" tabindex="-1" title="${esc(c.body)}"><span class="ma-sc-review-where">${FILE_NAME}:${c.line}</span><span class="ma-sc-review-body">${esc(c.body)}</span></button>`,
            )
            .join("")}</div>` +
          `<div class="ma-sc-review-actions">${sendSplit()}<button class="ma-btn ma-ghost ma-sm ma-rs-discard" type="button" tabindex="-1" data-discard>${confirmingDiscard ? `Discard ${countLabel(comments.length)}?` : "Discard"}</button></div></div>`;

    /** ReviewBar: only there once there's something to send. */
    const reviewBar = () =>
      comments.length === 0
        ? ""
        : `<div class="ma-fp-float"><div class="ma-rs-bar"><button class="ma-btn ma-ghost ma-sm ma-rs-count" type="button" tabindex="-1" aria-label="Jump to a comment">${icon("message-square", 11)}${countLabel(comments.length)}<span class="ma-rs-count-caret">${icon("chevron-up", 11)}</span></button>${sendSplit()}</div></div>`;

    const filePane = () =>
      `<div class="ma-fp"><div class="ma-fp-strip">` +
      `<button class="ma-fp-strip-btn" type="button" tabindex="-1" aria-label="Files">${icon("folder", 14)}</button>` +
      `<button class="ma-fp-strip-btn ma-fp-strip-on" type="button" tabindex="-1" aria-label="Source Control (2)">${icon("git-branch", 14)}<span class="ma-fp-count">2</span></button></div>` +
      `<div class="ma-fd"><div class="ma-fd-head"><span>Source Control</span><span class="ma-fd-spacer"></span>${toggle(view)}</div>${sourceControl(view)}${reviewSection()}</div>` +
      `<div class="ma-fp-editor-col"><div class="ma-fp-crumbs"><div class="ma-fp-crumb-path" title="${FILE_PATH}">` +
      `<span class="ma-fp-crumb-part"><span class="ma-fp-crumb">src</span></span><span class="ma-fp-crumb-part"><span class="ma-fp-crumb-sep">/</span><span class="ma-fp-crumb">tides</span></span>` +
      `<span class="ma-fp-crumb-part"><span class="ma-fp-crumb-sep">/</span><span class="ma-fp-crumb-last">${FILE_NAME}</span></span></div>` +
      `<span class="ma-fp-diff-tag">Diff vs ${view === "local" ? "HEAD" : "main"}</span><button class="ma-btn ma-secondary ma-sm ma-fp-open-plain" type="button" tabindex="-1">Open file</button></div>` +
      `<div class="ma-fp-stack">${diff()}</div>${reviewBar()}</div></div>`;

    const startComposing = (line: number, body: string, editing: Comment | null) => {
      composing = { line, body, initial: body, editing };
      composerFocused = true;
      focus = "file";
      caret = body.length;
      selected = null;
      ctx.render();
    };

    const saveComposer = () => {
      if (!composing || !composing.body.trim()) return;
      const body = composing.body.trim();
      if (composing.editing) composing.editing.body = body;
      else comments.push({ id: nextComment++, line: composing.line, body });
      composing = null;
      ctx.render();
    };

    const cancelComposer = () => {
      composing = null;
      ctx.render();
    };

    /** The selection moves to a changed line: in place, or the chip being reached for would be redrawn under the pointer. */
    const select = (line: number) => {
      if (composing || selected === line || comments.some((c) => c.line === line)) return;
      selected = line;
      for (const el of root.querySelectorAll<HTMLElement>("[data-line]")) {
        const on = Number(el.dataset.line) === line;
        el.classList.toggle("ma-cm-selected", on);
        el.querySelector(".ma-cm-chip-anchor")!.innerHTML = on ? chip : "";
      }
      fitChip();
    };

    /** A CodeMirror tooltip stays in the editor: past its right edge, the chip slides back. */
    const fitChip = () => {
      const el = root.querySelector<HTMLElement>(".ma-cm-chip");
      const editor = root.querySelector<HTMLElement>("[data-diff]");
      if (!el || !editor) return;
      el.style.left = "0";
      const scale = root.getBoundingClientRect().width / root.offsetWidth;
      const over = (el.getBoundingClientRect().right - editor.getBoundingClientRect().right) / scale;
      if (over > 0) el.style.left = `${-over}px`;
    };

    /** sendPromptToAgent: into the pane, the pane focused, the toast; useReviewSend then clears the drafts. */
    const send = () => {
      if (comments.length === 0) return;
      const sent = comments;
      const label = countLabel(sent.length);
      const thisRun = ++run;
      comments = [];
      confirmingDiscard = false;
      // Only drafts go: a new comment still being written stays open, an edit's draft has gone.
      if (composing?.editing) composing = null;
      selected = null;
      focus = "agent";
      status = "thinking";
      secs = 0;
      watchingAgent = true;
      log.push(...wrapped(flatPrompt(sent, rounded), '<span class="d">&gt;</span> ', "  ", TERMINAL_COLUMNS), "");
      ctx.render();
      toasts.show(`Sent ${label} to ${AGENT}`, TOAST_ID);

      const asPrefilled = sent.map((c) => ({ c, plan: changedAt(c.line) })).filter(({ c, plan }) => c.body.trim() === plan.prefill);
      const wasRounded = rounded;
      const editsLine8 = !wasRounded && asPrefilled.some(({ c }) => c.line === 8);
      ctx.later(1000, () => {
        if (thisRun !== run) return;
        status = "working";
        secs = 1;
        if (editsLine8) {
          rounded = true;
          log.push(`<span class="g">●</span> Update(<b>${FILE_PATH}</b>)`, '  <span class="d">⎿  Updated with 1 addition and 1 removal</span>', "");
        } else {
          log.push(`<span class="g">●</span> Read(<b>${FILE_PATH}</b>)`, '  <span class="d">⎿  Read 16 lines</span>', "");
        }
      });
      ctx.later(2400, () => {
        if (thisRun !== run) return;
        status = "responded";
        const replies = sent.map((c) => {
          if (c.body.trim() !== changedAt(c.line).prefill) return `Took your comment on L${c.line} on its own terms.`;
          return c.line === 8 && wasRounded ? ALREADY_ROUNDED_REPLY : changedAt(c.line).reply;
        });
        replies.forEach((reply, i) => log.push(...wrapped(reply, i === 0 ? '<span class="g">●</span> ' : "  ", "  ", TERMINAL_COLUMNS)));
        log.push("");
        ctx.hold(REPLY_READ_MS, () => {
          if (thisRun !== run) return;
          watchingAgent = false;
          ctx.repan();
        });
      });
    };

    return {
      render: () => {
        const textarea = root.querySelector<HTMLTextAreaElement>("[data-composer]");
        if (textarea) {
          composerFocused = document.activeElement === textarea;
          caret = textarea.selectionStart;
        }
        return {
          projects: [
            {
              id: "harbor",
              name: "harbor",
              color: "cyan",
              selected: true,
              workspaces: [
                { id: "harbor-local", name: "local", branch: "main", isMain: true, active: false, indicator: null },
                { id: "tide-tables", name: "tide-tables", branch: "tide-tables", isMain: false, active: true, indicator: toWorkspaceIndicator({ status, pulse: false }), diffStats: { added: 5, removed: 4 } },
                { id: "dock-fees", name: "dock-fees", branch: "dock-fees", isMain: false, active: false, indicator: null },
              ],
            },
          ],
          agentGroups: [{ project: "harbor", agents: [{ id: "agent", title: AGENT, status, pulse: false }] }],
          unread: false,
          crumbs: ["harbor", "tide-tables"],
          main: tabbedPanel(
            [
              {
                id: "tide-tables",
                title: focus === "file" ? FILE_NAME : AGENT,
                active: true,
                status,
                pulse: false,
                icon: focus === "file" ? `<span class="ma-tab-icon">${icon("file-code", 12)}</span>` : "",
              },
            ],
            splitPanes(
              "horizontal",
              leafPane({ id: "agent", title: AGENT, focused: focus === "agent", hasChat: true, body: terminal() }),
              leafPane({ id: "file", title: FILE_NAME, focused: focus === "file", hasChat: false, body: "", content: filePane() }),
              AGENT_PANE_PERCENT,
            ),
          ),
          overlay: toasts.html(),
        };
      },
      drawn: () => {
        fitChip();
        const diffEl = root.querySelector<HTMLElement>("[data-diff]");
        diffEl?.addEventListener("mouseover", (e) => {
          const line = (e.target as Element).closest<HTMLElement>("[data-line]");
          if (line) select(Number(line.dataset.line));
        });
        const textarea = root.querySelector<HTMLTextAreaElement>("[data-composer]");
        if (!textarea) return;
        // CommentComposer's autoGrow: `auto` first, or the box could only ever grow.
        const grow = () => {
          textarea.style.height = "auto";
          textarea.style.height = `${textarea.scrollHeight + 2}px`;
        };
        grow();
        textarea.addEventListener("input", () => {
          composing!.body = textarea.value;
          root.querySelector<HTMLButtonElement>("[data-add]")!.disabled = !textarea.value.trim();
          grow();
        });
        if (composerFocused) {
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(caret, caret);
        }
      },
      onClick: (e) => {
        const t = e.target as Element | null;
        if (!t || !root.contains(t)) return;
        const hit = (selector: string) => t.closest<HTMLElement>(selector);
        if (hit("[data-comment-chip]") && selected !== null) return startComposing(selected, changedAt(selected).prefill, null);
        if (hit("[data-add]")) return saveComposer();
        if (hit("[data-cancel]")) return cancelComposer();
        if (hit("[data-send]")) return send();
        // useDiscardConfirm: the first press arms it, the second throws the drafts away, and unanswered it backs out.
        if (hit("[data-discard]")) {
          const press = ++discardPress;
          if (confirmingDiscard) {
            confirmingDiscard = false;
            comments = [];
          } else {
            confirmingDiscard = true;
            ctx.hold(DISCARD_CONFIRM_MS, () => {
              if (press !== discardPress) return;
              confirmingDiscard = false;
              ctx.render();
            });
          }
          return ctx.render();
        }
        const cardEl = hit("[data-comment]");
        const shown = comments.find((c) => String(c.id) === cardEl?.dataset.comment);
        if (shown && hit("[data-edit]")) {
          // diff-comments.tsx `editComment`: an open composer holding edits isn't thrown away; it's shown instead.
          if (composing && composing.body.trim() !== composing.initial.trim()) {
            root.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus({ preventScroll: true });
            return;
          }
          return startComposing(shown.line, shown.body, shown);
        }
        if (shown && hit("[data-delete]")) {
          comments = comments.filter((c) => c !== shown);
          return ctx.render();
        }
        const scm = hit("[data-scm-view]")?.dataset.scmView;
        if (scm === "local" || scm === "branch") {
          view = scm;
          return ctx.render();
        }
        const line = hit("[data-line]");
        if (line) select(Number(line.dataset.line));
        const pane = hit("[data-pane]")?.dataset.pane;
        if ((pane === "agent" || pane === "file") && pane !== focus) {
          focus = pane;
          ctx.render();
        }
      },
      onKey: (e) => {
        if (e.target !== root.querySelector("[data-composer]")) return;
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          saveComposer();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelComposer();
        }
      },
      // The diff with its comments and Send, or the agent, from a send until its reply has been read.
      phoneCrop: () => (watchingAgent ? { x: 150, y: 24 } : { x: 716, y: 24 }),
      // The agent's spinner and timer, in its own pane: a redraw would take the composer's focus and the chip from under the pointer.
      onFrame: ({ ms }) => {
        if (status !== "thinking" && status !== "working") return;
        sinceTick += ms;
        if (sinceTick < TICK_MS) return;
        sinceTick %= TICK_MS;
        tick++;
        if (tick % 4 === 0) secs++;
        const term = root.querySelector('[data-pane="agent"] .ma-term');
        if (term) term.innerHTML = terminal();
      },
    };
  },
};
