// Browser: a browser pane beside an agent's terminal, picking on from the start. Clicking
// the page pins an element and opens its note; Send to… takes the notes to an agent, as
// PageNotes.tsx, usePageNotes.ts, lib/page-notes.ts and electron/page-pins-script.ts do it.
import "./browser.css";
import { agentDot, esc, leafPane, splitPanes, tabbedPanel, type AgentRow, type TabData } from "../../shell/chrome";
import { icon } from "../../shell/icons";
import { TICK_MS } from "../../shell/render";
import { toWorkspaceIndicator, type AgentStatus } from "../../shell/state";
import { claudeBox, cursor } from "../../shell/terminals";
import { createToasts } from "../../shell/toasts";
import { nothingFocused, type Slide } from "../slide";

const PAGE_URL = "http://localhost:5173/berths";
const PAGE_TITLE = "Berths · Bilge & Barnacle";
const WORKSPACE_DIR = "~/harbor/berth-page";
/** The pane's width after a drag of the split's divider: the page wants the room. */
const AGENT_PANE_PERCENT = 36;
const TERMINAL_COLUMNS = 44;
/** On a phone, how long the agent's reply stays in view before the crop goes back to the page. */
const REPLY_READ_MS = 2500;
/** usePageNotes's `page-notes-${paneId}`: a second send or copy replaces the toast. */
const TOAST_ID = "page-notes-browser";

/** note-placement.ts. */
const EDGE = 8;
const GAP = 8;
const PILL_CLEARANCE = 52;
const POPOVER_WIDTH = 240;

/** lib/page-notes.ts `HTML_SNIPPET_MAX`. */
const HTML_SNIPPET_MAX = 300;

/** The elements with a note ready, by id: what's wrong with them, and what the agent says about it. */
const PREFILLS: Record<string, { note: string; reply: string }> = {
  "longest-free": { note: "Says NaN. Should be 52 ft.", reply: "Longest free now reads 52 ft. A berth with no length was breaking the sum." },
  book: { note: "Too faint to read. Make it solid.", reply: "Book a berth is now the page's solid button." },
};
const GENERIC_PREFILL = "Tighten this up.";
const GENERIC_REPLY = "Tightened it up.";
/** What the agent says of a pin on something it's already fixed. */
const ALREADY_FIXED_REPLY = "That one's already fixed, so I've left it as it is.";

/** The made-up app in the pane. Its text and markup are what the prompt quotes. */
function guestPage(fixed: ReadonlySet<string>): string {
  const row = (id: string, vessel: string, length: string, rate: string, state: string) =>
    `<tr id="${id}"><td>${id.toUpperCase()}</td><td>${vessel}</td><td>${length}</td><td>${rate}</td><td class="${state}">${state === "free" ? "Free" : "Held"}</td></tr>`;
  return (
    `<header><span class="brand">Bilge &amp; Barnacle Moorings</span><nav><a>Berths</a><a>Tides</a><a>Fees</a></nav></header>` +
    `<main><div class="lead"><div><h1 id="heading">Berths this week</h1><p>12 of 40 free. High water at 14:20.</p></div>` +
    `<button id="book"${fixed.has("book") ? ' class="fixed"' : ""}>Book a berth</button></div>` +
    `<div class="stats"><div class="stat" id="free-now"><small>Free now</small><strong>12</strong></div>` +
    `<div class="stat" id="longest-free"><small>Longest free</small><strong>${fixed.has("longest-free") ? "52 ft" : "NaN ft"}</strong></div>` +
    `<div class="stat" id="next-tide"><small>Next tide</small><strong>14:20</strong></div></div>` +
    `<table id="berths"><thead><tr><th>Berth</th><th>Vessel</th><th>Length</th><th>Rate</th><th>Status</th></tr></thead><tbody>` +
    row("a1", "Reel Trouble", "34 ft", "£41", "held") +
    row("a2", "Seas the Day", "28 ft", "£36", "held") +
    row("b4", "—", "52 ft", "£58", "free") +
    row("c2", "Knot Working", "41 ft", "£47", "held") +
    row("c7", "—", "30 ft", "£38", "free") +
    `</tbody></table><footer id="small-print">Bilge &amp; Barnacle is not responsible for gulls.</footer></main>`
  );
}

/** picker-script.ts `getSelectorPath`, with the pane's page root standing in for `<body>`. */
function selectorPath(el: Element, page: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== page) {
    let seg = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${seg}#${CSS.escape(node.id)}`);
      return parts.join(" > ");
    }
    const className = node.getAttribute("class")?.trim();
    if (className) seg += className.split(/\s+/).slice(0, 3).map((c) => `.${CSS.escape(c)}`).join("");
    const siblings: Element[] = node.parentElement ? [...node.parentElement.children].filter((s) => s.tagName === node!.tagName) : [];
    if (siblings.length > 1) seg += `:nth-child(${siblings.indexOf(node) + 1})`;
    parts.unshift(seg);
    node = node.parentElement;
  }
  return ["html", "body", ...parts].join(" > ");
}

/** Where an element is under the page root, which outlives a redraw of the page's markup. */
function pathTo(el: Element, page: Element): number[] {
  const path: number[] = [];
  for (let node: Element = el; node !== page; node = node.parentElement!) path.unshift([...node.parentElement!.children].indexOf(node));
  return path;
}
const atPath = (page: Element, path: readonly number[]) => path.reduce<Element | undefined>((node, i) => node?.children[i], page);

type Note = { id: number; selector: string; path: number[]; html: string; shot: string; note: string; prefill: string; reply: string; fixes: string | null };
type Rect = { x: number; y: number; width: number; height: number };

const countLabel = (n: number) => (n === 1 ? "1 note" : `${n} notes`);

/** note-placement.ts `placeNotePopover`. */
function placeNotePopover(element: Rect, pane: { width: number; height: number }, height: number) {
  const maxLeft = Math.max(EDGE, pane.width - POPOVER_WIDTH - EDGE);
  const left = Math.min(Math.max(element.x, EDGE), maxLeft);
  const floor = pane.height - PILL_CLEARANCE;
  const below = element.y + element.height + GAP;
  const above = element.y - GAP - height;
  let top: number;
  if (below + height <= floor) top = below;
  else if (above >= EDGE) top = above;
  else top = element.y + 14;
  return { left, top: Math.min(Math.max(top, EDGE), Math.max(EDGE, floor - height)) };
}

/** lib/page-notes.ts `htmlSnippet`. */
function htmlSnippet(html: string): string {
  const flat = html.replace(/\s+/g, " ").trim();
  return flat.length > HTML_SNIPPET_MAX ? `${flat.slice(0, HTML_SNIPPET_MAX)}…` : flat;
}

/** lib/page-notes.ts `pageNotesPrompt` with the app's default text, through lib/agent-command.ts `flattenPrompt`. */
function flatPrompt(notes: readonly Note[]): string {
  const lines = notes.some((n) => !n.note.trim()) ? ["An element with no note is one I picked out for you to look at."] : [];
  notes.forEach((n, i) => {
    lines.push(`[${i + 1}] ${n.selector} — ${n.note.trim() || "(no note)"}`);
    lines.push(`    Screenshot: ${n.shot}`);
    lines.push(`    HTML: ${htmlSnippet(n.html)}`);
  });
  const prompt = [
    `I left ${countLabel(notes.length)} on the page at ${PAGE_URL}. Take each on its own terms — it may be a question about the page rather than a request to change it. Answer questions directly, and only edit code where a note actually asks for that.`,
    ...lines,
  ].join("\n");
  return prompt.replace(/\s*[\r\n]\s*/g, " ").trim();
}

/** How the agent's own box wraps what it's sent; a word wider than the box breaks across rows. */
function wrapped(text: string, first: string, rest: string, columns: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (let word of text.split(" ")) {
    if (row && row.length + 1 + word.length > columns) {
      rows.push(row);
      row = "";
    }
    while (word.length > columns) {
      rows.push(word.slice(0, columns));
      word = word.slice(columns);
    }
    row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  return rows.map((r, i) => (i === 0 ? first : rest) + esc(r));
}

/** A pane header's button, as LeafPane's browser controls draw them. */
const navButton = (label: string, content: string, attrs = "") =>
  `<button class="ma-pane-btn" type="button" tabindex="-1" title="${label}" aria-label="${label}" ${attrs}>${content}</button>`;

/** LeafPane's browser header. Nowhere to go back to, and the zoom and DevTools keep their look and hover. */
const browserHeader = (picking: boolean) =>
  `<div class="ma-bp-nav">` +
  navButton("Back", icon("arrow-left", 12), "disabled") +
  navButton("Forward", icon("arrow-right", 12), "disabled") +
  navButton("Reload", icon("rotate-cw", 12)) +
  `<div class="ma-bp-url"><span class="ma-bp-url-icon">${icon("lock-open", 10)}</span>` +
  `<input class="ma-bp-url-input" type="text" tabindex="-1" readonly spellcheck="false" placeholder="Enter URL" aria-label="Enter URL" value="${PAGE_URL.replace(/^https?:\/\//, "")}"></div>` +
  navButton("Pick elements", icon("crosshair", 12), `data-pick-toggle aria-pressed="${picking}"`).replace('class="ma-pane-btn"', `class="ma-pane-btn${picking ? " ma-bp-active" : ""}"`) +
  navButton("Zoom in", icon("zoom-in", 12)) +
  navButton("Zoom out", icon("zoom-out", 12)) +
  navButton("DevTools", icon("code-xml", 12)) +
  `</div>`;

const pickingHint = () =>
  `<div class="ma-picking-hint" data-picking-hint>Click elements to collect them<span class="ma-picking-keys"> · <kbd class="ma-kbd">Esc</kbd> to stop</span></div>`;

type Agent = AgentRow & { status: AgentStatus; log: string[]; run: number; secs: number };

export const browser: Slide = {
  id: "browser",
  label: "Browser",
  title: "Point at what's wrong.",
  description: "Pin elements in a browser pane, add a note to each, and send them all to an agent.",
  hint: "Click something on the page, add a note, then send it.",
  alt: "An interactive mock of Manor: an agent's terminal beside a browser pane showing a small web app, with element picking on, one element pinned with a note, and a pill offering to send the notes to an agent.",
  enter(ctx) {
    const { root } = ctx;
    const toasts = createToasts(root, ctx.hold);

    const firstAgent: Agent = {
      id: "agent",
      title: "Berth page",
      pulse: false,
      status: "responded",
      run: 0,
      secs: 0,
      log: [
        ...claudeBox(WORKSPACE_DIR),
        '<span class="d">&gt;</span> Build the berths page: stats, then the',
        "  week's table",
        "",
        '<span class="g">●</span> Write(<b>src/pages/Berths.tsx</b>)',
        '  <span class="d">⎿  Wrote 84 lines</span>',
        "",
        '<span class="g">●</span> The page is up on localhost:5173. Have a',
        "  look.",
        "",
      ],
    };
    const agents: Agent[] = [firstAgent];
    /** Agents after the first, each in a tab of its own: `Send to… › New agent`. */
    let openTab = "main";
    let focus: "agent" | "browser" = "browser";

    let picking = true;
    let notes: Note[] = [];
    let nextNote = 0;
    let openNote: { id: number; openedWith: string } | null = null;
    /** The start state's popover shows its note without taking the keyboard. */
    let noteFocused = false;
    let pageFocused = false;
    let caret = 0;
    let menuOpen = false;
    const fixed = new Set<string>();
    /** The elements a run still under way will fix, and the agent running it. */
    const fixing = new Map<string, Agent>();
    /** A phone is looking at the agent beside the page: from a send until its reply has been read. */
    let watchingAgent = false;

    let tick = 0;
    let sinceTick = 0;

    const page = () => root.querySelector<HTMLElement>("[data-guest]");
    const web = () => root.querySelector<HTMLElement>("[data-web]");
    const scale = () => root.getBoundingClientRect().width / root.offsetWidth;

    const rectIn = (el: Element, box: Element): Rect => {
      const s = scale();
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return { x: (r.left - b.left) / s, y: (r.top - b.top) / s, width: r.width / s, height: r.height / s };
    };

    // ---- the terminal -------------------------------------------------------

    const terminal = (a: Agent) => {
      const focused = openTab === "main" ? a === firstAgent && focus === "agent" : openTab === a.id;
      const live =
        a.status === "thinking" || a.status === "working"
          ? [`<span class="o">${["✶", "✻", "✽", "✻"][tick % 4]} ${a.status === "thinking" ? "Thinking" : "Composing"}… <span class="d">(${a.secs}s · esc to interrupt)</span></span>`, ""]
          : [];
      return [...a.log, ...live, `<span class="d">&gt;</span> ${cursor(focused)}`].slice(-38).join("\n");
    };

    // ---- the pins, drawn over the page once its elements have a place -------

    const layoutPins = () => {
      const guest = page();
      const webEl = web();
      const layer = root.querySelector<HTMLElement>("[data-pins]");
      if (!guest || !webEl || !layer) return;
      for (const el of layer.querySelectorAll("[data-pin-el]")) el.remove();
      const pane = { width: webEl.clientWidth, height: webEl.clientHeight };
      notes.forEach((n, i) => {
        const el = atPath(guest, n.path);
        if (!el) return;
        const r = rectIn(el, webEl);
        layer.insertAdjacentHTML(
          "beforeend",
          `<div class="ma-pins-ring" data-pin-el style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px"></div>` +
            `<button class="ma-pins-pin" type="button" tabindex="-1" data-pin-el data-pin="${n.id}" style="left:${Math.max(0, r.x - 9)}px;top:${Math.max(0, r.y - 9)}px">${i + 1}</button>`,
        );
        if (n.id !== openNote?.id) return;
        const popover = root.querySelector<HTMLElement>("[data-note]");
        if (!popover) return;
        const { left, top } = placeNotePopover(r, pane, popover.offsetHeight);
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
      });
    };

    const hideHover = () => {
      const box = root.querySelector<HTMLElement>("[data-hover]");
      if (box) box.style.display = "none";
    };

    /** page-pins-script.ts `onMouseOver`: the element under the pointer, anything but the page's root. */
    const showHover = (target: Element) => {
      const guest = page();
      const box = root.querySelector<HTMLElement>("[data-hover]");
      const webEl = web();
      if (!picking || !guest || !box || !webEl || target === guest || !guest.contains(target)) return hideHover();
      const r = rectIn(target, webEl);
      box.style.cssText = `display:block;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`;
    };

    // ---- the notes ----------------------------------------------------------

    const openNoteOf = (n: Note) => {
      openNote = { id: n.id, openedWith: n.note };
      noteFocused = true;
      pageFocused = false;
      caret = n.note.length;
    };

    const addPin = (el: Element, guest: Element) => {
      const owner = el.closest("[id]");
      const known = owner && guest.contains(owner) ? PREFILLS[owner.id] : undefined;
      // Already fixed, there's nothing to complain of: the note opens empty, as the app's always does.
      const settled = !!known && fixed.has(owner!.id);
      const prefill = settled ? "" : (known?.note ?? GENERIC_PREFILL);
      const note: Note = {
        id: nextNote++,
        selector: selectorPath(el, guest),
        path: pathTo(el, guest),
        html: el.outerHTML.slice(0, 2000),
        // electron/server/pasted-images.ts's name, which main saves each pick's screenshot under.
        shot: `/Users/you/.manor/pasted-images/${Date.now()}-${nextNote.toString(16).padStart(8, "0")}.png`,
        note: prefill,
        prefill,
        reply: settled ? ALREADY_FIXED_REPLY : (known?.reply ?? GENERIC_REPLY),
        fixes: known && !settled ? owner!.id : null,
      };
      notes.push(note);
      return note;
    };

    /** PinNotePopover's `onDone`: closed, and the keyboard back with the page. */
    const closeNote = () => {
      openNote = null;
      noteFocused = false;
      pageFocused = true;
      ctx.render();
    };

    const copyPrompt = () => {
      void navigator.clipboard?.writeText(flatPrompt(notes)).catch(() => {});
      ctx.render();
      toasts.show(`Copied ${countLabel(notes.length)} to the clipboard`, TOAST_ID);
    };

    /** agent-send.ts `sendPromptToAgent`, then usePageNotes's `send`: into the pane, the pane focused, the toast, the queue empty. */
    const send = (target: Agent | "new") => {
      if (notes.length === 0) return;
      const sent = notes;
      const label = countLabel(sent.length);
      let agent: Agent;
      if (target === "new") {
        agent = {
          id: `agent-${agents.length + 1}`,
          title: "Page notes",
          pulse: false,
          status: "thinking",
          run: 0,
          secs: 0,
          log: claudeBox(WORKSPACE_DIR),
        };
        agents.push(agent);
      } else {
        agent = target;
      }
      const thisRun = ++agent.run;
      notes = [];
      openNote = null;
      noteFocused = false;
      pageFocused = false;
      menuOpen = false;
      openTab = agent === firstAgent ? "main" : agent.id;
      if (agent === firstAgent) {
        focus = "agent";
        watchingAgent = true;
      }
      agent.status = "thinking";
      agent.secs = 0;
      agent.log.push(...wrapped(flatPrompt(sent), '<span class="d">&gt;</span> ', "  ", TERMINAL_COLUMNS), "");
      ctx.render();
      toasts.show(target === "new" ? `Sent ${label} to a new agent` : `Sent ${label} to ${agent.title}`, TOAST_ID);

      // Each element's fix is claimed here, at send: this agent's last run has just been dropped, so what it was fixing is open again.
      for (const [owner, by] of fixing) if (by === agent) fixing.delete(owner);
      const asPrefilled = sent.filter((n) => n.note.trim() === n.prefill);
      const fixes = new Set(asPrefilled.flatMap((n) => (n.fixes && !fixed.has(n.fixes) && !fixing.has(n.fixes) ? [n.fixes] : [])));
      for (const owner of fixes) fixing.set(owner, agent);
      // Two pins on one element are one thing said twice.
      const replies = [
        ...new Set(
          sent.map((n, i) => {
            if (n.note.trim() !== n.prefill) return `Took your note on [${i + 1}] on its own terms.`;
            return n.fixes && !fixes.has(n.fixes) ? ALREADY_FIXED_REPLY : n.reply;
          }),
        ),
      ];
      ctx.later(1000, () => {
        if (thisRun !== agent.run) return;
        agent.status = "working";
        agent.secs = 1;
        agent.log.push(
          fixes.size > 0 ? '<span class="g">●</span> Update(<b>src/pages/Berths.tsx</b>)' : '<span class="g">●</span> Read(<b>src/pages/Berths.tsx</b>)',
          fixes.size > 0 ? '  <span class="d">⎿  Updated with 4 additions and 3 removals</span>' : '  <span class="d">⎿  Read 84 lines</span>',
          "",
        );
      });
      ctx.later(2400, () => {
        if (thisRun !== agent.run) return;
        agent.status = "responded";
        for (const owner of fixes) {
          fixed.add(owner);
          fixing.delete(owner);
        }
        replies.forEach((reply, i) => agent.log.push(...wrapped(reply, i === 0 ? '<span class="g">●</span> ' : "  ", "  ", TERMINAL_COLUMNS)));
        agent.log.push("");
        ctx.hold(REPLY_READ_MS, () => {
          if (thisRun !== agent.run) return;
          watchingAgent = false;
          ctx.repan();
        });
      });
    };

    // ---- the pane's overlay --------------------------------------------------

    const popover = () => {
      const index = notes.findIndex((n) => n.id === openNote?.id);
      const n = notes[index];
      if (!n) return "";
      return (
        `<div class="ma-note" data-note>` +
        `<div class="ma-note-header"><span class="ma-note-number">${index + 1}</span><span class="ma-note-selector" title="${esc(n.selector)}">${esc(n.selector)}</span>` +
        `<button class="ma-btn ma-ghost ma-sm ma-note-icon" type="button" tabindex="-1" aria-label="Delete note" data-note-delete>${icon("trash-2", 12)}</button></div>` +
        `<input class="ma-note-input" type="text" tabindex="-1" spellcheck="false" placeholder="Add a note (optional)" value="${esc(n.note)}" data-note-input>` +
        `<div class="ma-note-footer"><span class="ma-note-keys"><kbd class="ma-kbd">↵</kbd> save · <kbd class="ma-kbd">Esc</kbd> skip</span>` +
        `<button class="ma-btn ma-primary ma-sm" type="button" tabindex="-1" data-note-save>Save</button></div></div>`
      );
    };

    const pill = () =>
      notes.length === 0
        ? ""
        : `<div class="ma-notes-pill" data-pill><span class="ma-notes-count"><strong>${countLabel(notes.length)}</strong> <span class="ma-notes-where">on this page</span></span>` +
          `<button class="ma-btn ma-ghost ma-sm" type="button" tabindex="-1" data-notes-copy>Copy</button>` +
          `<button class="ma-btn ma-primary ma-sm ma-notes-send" type="button" tabindex="-1" data-notes-send aria-expanded="${menuOpen}">Send to…${icon("chevron-down", 12)}</button>` +
          `<button class="ma-btn ma-ghost ma-sm ma-note-icon" type="button" tabindex="-1" aria-label="Clear notes" data-notes-clear>${icon("x", 12)}</button></div>`;

    /** AgentTargetMenu: the workspace's agents, New agent, then PageNotes's clipboard row. */
    const sendMenu = () => {
      if (!menuOpen) return "";
      const row = (attrs: string, mark: string, name: string, hint = "") =>
        `<button class="ma-btn ma-ghost ma-sm ma-send-row" type="button" tabindex="-1" ${attrs}><span class="ma-send-icon">${mark}</span><span class="ma-send-name">${esc(name)}</span>${hint}</button>`;
      const separator = `<div class="ma-send-separator"></div>`;
      return (
        `<div class="ma-send-menu" tabindex="-1" data-send-menu>` +
        agents
          .map((a) =>
            row(
              `data-send-agent="${a.id}"`,
              agentDot(a.status, false),
              a.title,
              a.status === "thinking" || a.status === "working" ? `<span class="ma-send-hint">will interrupt current turn</span>` : "",
            ),
          )
          .join("") +
        separator +
        row("data-send-new", icon("plus", 12), "New agent") +
        separator +
        row("data-send-copy", icon("clipboard-copy", 12), "Copy to clipboard") +
        `</div>`
      );
    };

    const browserPane = () =>
      `<div class="ma-bp"><div class="ma-bp-web" data-web>` +
      `<div class="ma-guest" data-guest tabindex="-1">${guestPage(fixed)}</div>` +
      `<div class="ma-pins" data-pins><div class="ma-pins-hover" data-hover></div></div>` +
      `<div class="ma-notes-layer">${picking ? pickingHint() : ""}${popover()}${pill()}</div>` +
      `</div></div>`;

    /** Radix's `side="top" align="end" sideOffset={6}`, over the pill's Send to…. */
    const placeMenu = () => {
      const menu = root.querySelector<HTMLElement>("[data-send-menu]");
      const trigger = root.querySelector<HTMLElement>("[data-notes-send]");
      if (!menu || !trigger) return;
      const r = rectIn(trigger, root);
      menu.style.left = `${Math.max(8, r.x + r.width - menu.offsetWidth)}px`;
      menu.style.top = `${r.y - 6 - menu.offsetHeight}px`;
    };

    /** A press on the page: the pick page-pins-script's `onClick` reports, and the note usePageNotes opens for it. */
    const pick = (target: Element) => {
      const guest = page();
      if (!guest || target === guest || !guest.contains(target)) return;
      openNoteOf(addPin(target, guest));
      hideHover();
      ctx.render();
    };

    // Picking starts with one element pinned and its note showing, so a visitor who only watches sees what it does.
    let seeded = false;

    return {
      render: () => {
        const input = root.querySelector<HTMLInputElement>("[data-note-input]");
        if (input && !noteFocused) noteFocused = document.activeElement === input;
        if (input && document.activeElement === input) caret = input.selectionStart ?? caret;
        const status = firstAgent.status;
        const worst = agents.find((a) => a.status === "working") ?? agents.find((a) => a.status === "thinking") ?? firstAgent;
        const mainTab: TabData = {
          id: "main",
          title: focus === "browser" ? PAGE_TITLE : firstAgent.title,
          active: openTab === "main",
          status,
          pulse: false,
          icon: focus === "browser" ? `<span class="ma-tab-icon">${icon("globe", 12)}</span>` : "",
        };
        const extra = agents.slice(1);
        const shownAgent = extra.find((a) => a.id === openTab);
        return {
          projects: [
            {
              id: "harbor",
              name: "harbor",
              color: "cyan",
              selected: true,
              workspaces: [
                { id: "harbor-local", name: "local", branch: "main", isMain: true, active: false, indicator: null },
                { id: "berth-page", name: "berth-page", branch: "berth-page", isMain: false, active: true, indicator: toWorkspaceIndicator({ status: worst.status, pulse: false }), diffStats: { added: 84, removed: 0 } },
                { id: "dock-fees", name: "dock-fees", branch: "dock-fees", isMain: false, active: false, indicator: null },
              ],
            },
          ],
          agentGroups: [{ project: "harbor", agents: agents.map((a) => ({ id: a.id, title: a.title, status: a.status, pulse: false })) }],
          unread: false,
          crumbs: ["harbor", "berth-page"],
          main: tabbedPanel(
            [mainTab, ...extra.map((a) => ({ id: a.id, title: a.title, active: openTab === a.id, status: a.status, pulse: false }))],
            shownAgent
              ? leafPane({ id: shownAgent.id, title: shownAgent.title, focused: true, hasChat: true, body: terminal(shownAgent) })
              : splitPanes(
                  "horizontal",
                  leafPane({ id: "agent", title: firstAgent.title, focused: focus === "agent", hasChat: true, body: terminal(firstAgent) }),
                  leafPane({ id: "browser", title: PAGE_TITLE, focused: focus === "browser", hasChat: false, body: "", content: browserPane(), header: browserHeader(picking) }),
                  AGENT_PANE_PERCENT,
                ),
          ),
          overlay: `${sendMenu()}${toasts.html()}`,
        };
      },
      drawn: () => {
        const guest = page();
        if (guest && !seeded) {
          seeded = true;
          const first = guest.querySelector("#longest-free");
          if (first) {
            const note = addPin(first, guest);
            openNote = { id: note.id, openedWith: note.note };
            ctx.render();
            return;
          }
        }
        layoutPins();
        placeMenu();
        web()?.addEventListener("mouseover", (e) => {
          const target = e.target as Element;
          if (target.closest("[data-pin]")) return hideHover();
          if (guest?.contains(target)) showHover(target);
        });
        const input = root.querySelector<HTMLInputElement>("[data-note-input]");
        // Typed in place: a redraw would take the focus from the field.
        input?.addEventListener("input", () => {
          const n = notes.find((x) => x.id === openNote?.id);
          if (n) n.note = input.value;
        });
        // What a redraw took the keyboard from gets it back, unless it has gone elsewhere on the page in the meantime.
        if (!nothingFocused()) return;
        // Radix's menu takes the keyboard: the click that opened it redrew its button away, and Esc needs somewhere to land. Shut, the keyboard falls back to the note or the page.
        if (menuOpen) {
          root.querySelector<HTMLElement>("[data-send-menu]")?.focus({ preventScroll: true });
        } else if (input && noteFocused) {
          input.focus({ preventScroll: true });
          input.setSelectionRange(caret, caret);
        } else if (pageFocused) {
          guest?.focus({ preventScroll: true });
        }
      },
      onClick: (e) => {
        const t = e.target as Element | null;
        if (!t || !root.contains(t)) return;
        const hit = (selector: string) => t.closest<HTMLElement>(selector);

        // The agent menu shuts on a press outside it, and the press still lands.
        const inMenu = hit("[data-send-menu]");
        const wasOpen = menuOpen;
        if (menuOpen && !inMenu) menuOpen = false;

        if (hit("[data-send-new]")) return send("new");
        if (hit("[data-send-copy]")) {
          menuOpen = false;
          return copyPrompt();
        }
        const agentId = hit("[data-send-agent]")?.dataset.sendAgent;
        const chosen = agents.find((a) => a.id === agentId);
        if (chosen) return send(chosen);
        if (inMenu) return;

        if (hit("[data-notes-send]")) {
          menuOpen = !wasOpen;
          return ctx.render();
        }
        if (hit("[data-notes-copy]")) return copyPrompt();
        if (hit("[data-notes-clear]")) {
          notes = [];
          openNote = null;
          noteFocused = false;
          return ctx.render();
        }
        if (hit("[data-note-save]")) return closeNote();
        if (hit("[data-note-delete]")) {
          notes = notes.filter((n) => n.id !== openNote?.id);
          return closeNote();
        }
        if (hit("[data-note]") || hit("[data-pill]")) {
          focus = "browser";
          return wasOpen ? ctx.render() : undefined;
        }
        if (hit("[data-pick-toggle]")) {
          picking = !picking;
          focus = "browser";
          return ctx.render();
        }
        const pinned = notes.find((n) => String(n.id) === hit("[data-pin]")?.dataset.pin);
        if (pinned) {
          focus = "browser";
          openNoteOf(pinned);
          return ctx.render();
        }
        const tabId = hit("[data-tab]")?.dataset.tab;
        if (tabId && tabId !== openTab && !hit(".ma-tab-close")) {
          openTab = tabId;
          return ctx.render();
        }
        const guest = page();
        if (guest?.contains(t)) {
          focus = "browser";
          if (picking) return pick(t);
          pageFocused = true;
          return ctx.render();
        }
        const pane = hit("[data-pane]")?.dataset.pane;
        if ((pane === "agent" || pane === "browser") && pane !== focus) {
          focus = pane;
          return ctx.render();
        }
        if (wasOpen) ctx.render();
      },
      onKey: (e) => {
        const target = e.target as Element | null;
        if (!target || !root.contains(target)) return;
        const input = root.querySelector("[data-note-input]");
        if (menuOpen && e.key === "Escape") {
          e.preventDefault();
          menuOpen = false;
          return ctx.render();
        }
        if (target === input) {
          if (e.key === "Enter") {
            e.preventDefault();
            closeNote();
          } else if (e.key === "Escape") {
            // PinNotePopover: Escape puts back what the note said when it opened.
            e.preventDefault();
            const n = notes.find((x) => x.id === openNote?.id);
            if (n && openNote) n.note = openNote.openedWith;
            closeNote();
          }
          return;
        }
        // page-pins-script's `onKeyDown`: on the page, Escape ends picking; its pins stay.
        if (e.key === "Escape" && picking && page()?.contains(target)) {
          e.preventDefault();
          picking = false;
          hideHover();
          ctx.render();
        }
      },
      // The page with its pins, note and pill; the agent beside it, from a send until its reply has been read; or an agent with a tab of its own.
      phoneCrop: () => {
        if (openTab !== "main") return { x: 233, y: 24 };
        return watchingAgent ? { x: 150, y: 24 } : { x: 716, y: 24 };
      },
      // The agent's spinner and timer, in its own pane: a redraw would take the note's focus and the hover from under the pointer.
      onFrame: ({ ms }) => {
        const shown = openTab === "main" ? firstAgent : agents.find((a) => a.id === openTab);
        if (!agents.some((a) => a.status === "thinking" || a.status === "working")) return;
        sinceTick += ms;
        if (sinceTick < TICK_MS) return;
        sinceTick %= TICK_MS;
        tick++;
        if (tick % 4 === 0) for (const a of agents) if (a.status === "thinking" || a.status === "working") a.secs++;
        const term = shown && root.querySelector(`[data-pane="${shown.id}"] .ma-term`);
        if (term) term.innerHTML = terminal(shown);
      },
    };
  },
};
