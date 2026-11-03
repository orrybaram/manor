// Pull requests: the sidebar's PR badge and the card behind it, from failing checks
// through Fix checks to Squash and merge, as PrPopover and PrActions do it.
import "./pull-requests.css";
import { tabbedPanel, leafPane } from "../../shell/chrome";
import { icon, type IconName } from "../../shell/icons";
import { toWorkspaceIndicator, type AgentStatus } from "../../shell/state";
import { TICK_MS } from "../../shell/render";
import { claudeBox, cursor } from "../../shell/terminals";
import { createToasts } from "../../shell/toasts";
import type { Slide } from "../slide";

const AGENT = "Tide heights";
const NUMBER = 214;
const TITLE = "Show tide heights in feet";
const REPO = "https://github.com/harbor-co/harbor";

/** PrPopover's `HOVER_DELAY`, and its 150ms before a leave closes the card. */
const HOVER_OPEN_MS = 400;
const HOVER_CLOSE_MS = 150;
/** PrActions' `MERGED_HOLD_MS`: how long the merged moment plays before the PR is fetched again. */
const MERGED_HOLD_MS = 1300;
/** lib/merge-fill.ts `HALFWAY_MS`. */
const FILL_HALFWAY_MS = 450;
/** How long `gh pr merge` takes here, which the fill creeps through. */
const MERGE_MS = 1200;
/** How long `getPrAgentPrompt` takes here, with Fix checks' spinner on. */
const BRIEF_MS = 700;

type RunStatus = "failing" | "pending" | "passing";
type Run = { name: string; status: RunStatus };
type Phase = "idle" | "merging" | "merged";

const CHECK_ICON: Record<RunStatus, IconName> = { failing: "circle-x", pending: "circle-dot", passing: "circle-check" };
const CHECK_TONE: Record<RunStatus, string> = { failing: "bad", pending: "warn", passing: "good" };

/** PrActions' `MergeGlyph`. */
const MERGE_GLYPH =
  '<svg class="ma-pr-glyph" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<g class="ma-pr-zip-a"><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/></g><g class="ma-pr-zip-b"><circle cx="18" cy="18" r="3"/><path d="M15 18a9 9 0 0 1-9-9"/></g></svg>';

/** PrActions' `MERGED_BURST`. */
const MERGED_BURST = { count: 26, colours: ["--accent", "--magenta", "--yellow", "--green"], spread: 1 };

/** PrActions' `burst`: flecks in the theme's colours spray off the button and fall away. */
function burst(host: HTMLElement | null, { count, colours: names, spread }: typeof MERGED_BURST): void {
  if (!host || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const css = getComputedStyle(host);
  const colours = names.map((name) => css.getPropertyValue(name).trim() || "currentColor");
  for (let i = 0; i < count; i++) {
    const fleck = document.createElement("i");
    fleck.style.background = colours[i % colours.length]!;
    fleck.style.left = `${20 + Math.random() * 60}%`;
    host.append(fleck);
    const angle = -Math.PI * ((1 - spread) / 2 + Math.random() * spread);
    const speed = 50 + Math.random() * 80;
    const dx = Math.cos(angle) * speed;
    const dy = Math.sin(angle) * speed;
    const spin = Math.random() * 700;
    fleck
      .animate(
        [
          { opacity: 1, transform: "translate(0, 0) rotate(0deg)" },
          { opacity: 1, transform: `translate(${dx}px, ${dy}px) rotate(${spin / 2}deg)`, offset: 0.55 },
          { opacity: 0, transform: `translate(${dx * 1.2}px, ${dy + 60}px) rotate(${spin}deg)` },
        ],
        { duration: 900 + Math.random() * 400, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" },
      )
      .finished.then(
        () => fleck.remove(),
        () => fleck.remove(),
      );
  }
}

const iconWithClass = (name: IconName, size: number, className: string) => icon(name, size).replace("<svg ", `<svg class="${className}" `);

/** PrPopover's badge, its icon named for what it's waiting on. */
function badge(readiness: string, tone: string, name: IconName, number: number, data = ""): string {
  return (
    `<span class="ma-pr-badge ma-pr-${readiness}${tone ? ` ma-pr-icon-${tone}` : ""}" role="button" tabindex="-1" data-readiness="${readiness}" ${data}>` +
    `${iconWithClass(name, 10, "ma-pr-badge-icon")}#${number}</span>`
  );
}

export const pullRequests: Slide = {
  id: "pull-requests",
  label: "Pull requests",
  title: "Take it all the way to merged.",
  description: "The PR card shows failing checks, briefs the agent on them, and merges when they're green.",
  hint: "Press Fix checks, then Squash and merge.",
  alt: "An interactive mock of Manor: a workspace's pull request card, open from its sidebar badge, with one failing check, a Fix checks button and a disabled Squash and merge button.",
  enter(ctx) {
    const { root } = ctx;
    const toasts = createToasts(root, ctx.hold);

    let runs: Run[] = [
      { name: "typecheck", status: "failing" },
      { name: "lint", status: "passing" },
      { name: "unit", status: "passing" },
    ];
    let merged = false;
    let phase: Phase = "idle";
    let fillMs = 0;
    let briefing = false;
    let briefed = false;
    let cardOpen = true;
    /** Held open: from the start and once the checks are green. In between, the badge's hover opens it as in the app. */
    let pinned = true;
    let hover = 0;

    let status: AgentStatus = "responded";
    let tick = 0;
    let sinceTick = 0;
    let secs = 0;
    const log: string[] = [
      ...claudeBox("~/harbor/tide-tables"),
      '<span class="d">&gt;</span> Open a PR for the tide heights in feet',
      "",
      '<span class="g">●</span> Bash(<b>gh pr create --fill</b>)',
      `  <span class="d">⎿  ${REPO}/pull/${NUMBER}</span>`,
      "",
      `<span class="g">●</span> Opened PR #${NUMBER}. I'll wait for you on the checks.`,
      "",
    ];

    const count = (s: RunStatus) => runs.filter((r) => r.status === s).length;

    /** pr-readiness.ts `prVerdict`, for an approved PR. */
    const readiness = () => (merged ? "merged" : count("failing") > 0 ? "blocked" : count("pending") > 0 ? "pending" : "ready");

    const prBadge = () => {
      const r = readiness();
      const [tone, name]: [string, IconName] =
        r === "merged" ? ["", "git-merge"] : r === "blocked" ? ["bad", "circle-x"] : r === "pending" ? ["pending", "clock"] : ["good", "circle-check"];
      return badge(r, tone, name, NUMBER, `data-pr-badge aria-label="Pull request #${NUMBER}: ${TITLE}"`);
    };

    /** PrPopover's `SummaryRows`. */
    const summary = () => {
      const failing = count("failing");
      const pending = count("pending");
      const passing = count("passing");
      const [text, tone, name]: [string, string, IconName] =
        failing > 0
          ? [`${failing} failing, ${passing} passing`, "bad", "circle-x"]
          : pending > 0
            ? [`${pending} pending, ${passing} passing`, "warn", "clock"]
            : [`${passing}/${runs.length} passing`, "good", "circle-check"];
      return (
        `<div class="ma-pr-summary"><div class="ma-pr-row ma-pr-tone-${tone}">${icon(name, 12)}<span>${text}</span></div>` +
        `<div class="ma-pr-row ma-pr-tone-good">${icon("shield-check", 12)}<span>Approved</span></div></div>`
      );
    };

    /** The merge button, for what `mergeOffer` says. */
    const offer = () => {
      if (count("failing") > 0) return "Fix the failing checks first";
      if (count("pending") > 0) return "Waiting on checks or review, and this repo has no auto-merge";
      return null;
    };

    const mergeButton = (reason: string | null) => {
      const tone = reason ? "unavailable" : "ready";
      return (
        `<span class="ma-pr-split ma-pr-tone-${tone}${reason ? "" : " ma-pr-inviting"}" data-pr-split data-phase="idle">` +
        `<button class="ma-pr-main" type="button" tabindex="-1"${reason ? ` disabled title="${reason}"` : ""} data-pr-merge>${MERGE_GLYPH}<span data-pr-label>Squash and merge</span></button>` +
        (reason ? "" : `<button class="ma-pr-caret" type="button" tabindex="-1" aria-label="Choose how to merge">${icon("chevron-down", 12)}</button>`) +
        `<span class="ma-pr-burst" aria-hidden="true"></span></span>`
      );
    };

    /** PrActions: gone once the PR reads as merged. */
    const footer = () => {
      if (merged) return "";
      const reason = offer();
      if (count("failing") > 0) {
        return (
          `<div class="ma-pr-footer"><div class="ma-pr-footer-row"><span class="ma-pr-agents">` +
          `<button class="ma-btn ma-secondary ma-sm ma-pr-agent" type="button" tabindex="-1" title="Send the failing checks and their logs to this workspace's agent" data-pr-fix>${icon("bot", 12)}Fix checks</button>` +
          `</span><span class="ma-pr-spacer"></span>${mergeButton(reason)}</div><div class="ma-pr-reason">${reason}</div></div>`
        );
      }
      const tick = reason
        ? ""
        : `<label class="ma-pr-tick" data-pr-tick><button class="ma-pr-checkbox" type="button" tabindex="-1" role="checkbox" aria-checked="false" data-state="unchecked"></button>Delete workspace after merge</label>`;
      return (
        `<div class="ma-pr-footer"><div class="ma-pr-footer-row">${tick}<span class="ma-pr-spacer"></span>${mergeButton(reason)}</div>` +
        (reason ? `<div class="ma-pr-reason">${reason}</div>` : "") +
        `</div>`
      );
    };

    const header = () =>
      `${icon(merged ? "git-merge" : "git-pull-request", 14)}<span>#${NUMBER}</span><span class="ma-pr-state-${merged ? "merged" : "open"}" data-pr-state>${merged ? "Merged" : "Open"}</span>` +
      `<span class="ma-pr-diffstat"><span class="ma-pr-additions">+40</span><span class="ma-pr-deletions">−3</span></span>`;

    /** PrPopover's `PrDetails`. A check's row and the title link into GitHub in the app; here they only look it. */
    const card = () =>
      `<div class="ma-pr-card" data-pr-card><div class="ma-pr-details"><div class="ma-pr-header" data-pr-header>${header()}</div>` +
      `<div class="ma-pr-title" title="Open this pull request on GitHub">${TITLE}</div>${summary()}` +
      `<div class="ma-pr-scroll"><section class="ma-pr-section"><div class="ma-pr-section-label">Checks</div>` +
      runs
        .map(
          (r) =>
            `<div class="ma-pr-check" title="Open ${r.name} on GitHub">${iconWithClass(CHECK_ICON[r.status], 11, `ma-pr-tone-${CHECK_TONE[r.status]}`)}<span class="ma-pr-check-name">${r.name}</span><span class="ma-pr-check-workflow">CI</span></div>`,
        )
        .join("") +
      `</section></div>${footer()}</div></div>`;

    /** Radix's `side="right" align="start" sideOffset={8}`, from the badge. */
    const place = () => {
      const el = root.querySelector<HTMLElement>("[data-pr-card]");
      const trigger = root.querySelector<HTMLElement>("[data-pr-badge]");
      if (!el || !trigger) return;
      const origin = root.getBoundingClientRect();
      const scale = origin.width / root.offsetWidth;
      const rect = trigger.getBoundingClientRect();
      el.style.left = `${(rect.right - origin.left) / scale + 8}px`;
      el.style.top = `${(rect.top - origin.top) / scale}px`;
    };

    const hoverOpen = () => {
      const token = ++hover;
      if (pinned || cardOpen) return;
      ctx.after(HOVER_OPEN_MS, () => {
        if (token === hover) showCard();
      });
    };

    const hoverLeave = () => {
      const token = ++hover;
      if (pinned || !cardOpen) return;
      ctx.after(HOVER_CLOSE_MS, () => {
        if (token === hover) hideCard();
      });
    };

    const bindCard = () => {
      const el = root.querySelector<HTMLElement>("[data-pr-card]");
      el?.addEventListener("mouseenter", () => ++hover);
      el?.addEventListener("mouseleave", hoverLeave);
    };

    const showCard = () => {
      const layer = root.querySelector<HTMLElement>(".ma-pr-layer");
      if (cardOpen || !layer) return;
      cardOpen = true;
      layer.innerHTML = card();
      layer.firstElementChild!.classList.add("ma-pr-card-in");
      place();
      bindCard();
    };

    /** The real card fades out, and Radix keeps it mounted until it has. */
    const hideCard = () => {
      const el = root.querySelector<HTMLElement>("[data-pr-card]");
      cardOpen = false;
      if (!el) return;
      el.dataset.state = "closed";
      ctx.after(120, () => {
        if (!cardOpen) el.remove();
      });
    };

    /** The agent, on what it was briefed with: the fix pushed, the checks run again and go green one by one. */
    const agentWorks = () => {
      status = "thinking";
      ctx.later(900, () => {
        status = "working";
        secs = 1;
        log.push('<span class="g">●</span> Bash(<b>pnpm typecheck</b>)', "  <span class=\"d\">⎿  src/tides/format.ts(12,7): error TS2322</span>", "");
      });
      ctx.later(1800, () => {
        log.push('<span class="g">●</span> Update(<b>src/tides/format.ts</b>)', '  <span class="d">⎿  Updated with 1 addition and 1 removal</span>', "");
      });
      ctx.later(2700, () => {
        log.push('<span class="g">●</span> Bash(<b>git commit -am "Pass feet to formatFeet" &amp;&amp; git push</b>)', '  <span class="d">⎿  tide-tables -&gt; tide-tables</span>', "");
        runs = runs.map((r) => ({ ...r, status: "pending" }));
      });
      ctx.later(3500, () => {
        runs = [
          { name: "typecheck", status: "pending" },
          { name: "lint", status: "passing" },
          { name: "unit", status: "passing" },
        ];
      });
      // One callback, so nothing can land between the redraw and the card's rebuild.
      ctx.after(4300, () => {
        runs = [
          { name: "typecheck", status: "passing" },
          { name: "lint", status: "passing" },
          { name: "unit", status: "passing" },
        ];
        status = "responded";
        log.push('<span class="g">●</span> Pushed the fix to this branch. typecheck passes locally.', "");
        // Where this leaves the app: its card stays shut until the badge is hovered. A visitor shouldn't have to know that, so the slide's opens by itself.
        hover++;
        pinned = true;
        ctx.render();
        cardOpen = false;
        showCard();
      });
    };

    /** PrActions' `brief`: the spinner while the prompt's fetched, `onLeave` shuts the card, the prompt's sent, the toast. */
    const fixChecks = () => {
      if (briefing || briefed) return;
      briefing = true;
      const button = root.querySelector<HTMLButtonElement>("[data-pr-fix]");
      if (button) {
        button.disabled = true;
        button.innerHTML = `<span class="ma-pr-spin">${icon("loader-circle", 12)}</span>Fix checks`;
      }
      ctx.after(BRIEF_MS, () => {
        briefing = false;
        briefed = true;
        pinned = false;
        log.push(
          `<span class="d">&gt;</span> 1 check failing on PR #${NUMBER} (${TITLE}), ${REPO}/pull/${NUMBER}.`,
          "",
          "  ## typecheck (CI)",
          `  ${REPO}/actions/runs/9000/job/22`,
          "",
          "  Last lines of the failed log:",
          "  ```",
          "  &gt; tsc -p tsconfig.json",
          "  src/tides/format.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
          "  Process completed with exit code 2.",
          "  ```",
          "",
          "  Find the cause of each failure, fix it on this branch, check it passes locally, then commit and push.",
          "",
        );
        agentWorks();
        ctx.render();
        hideCard();
        toasts.show(`Sent the failing checks to ${AGENT}`);
      });
    };

    const split = () => root.querySelector<HTMLElement>("[data-pr-split]");

    /** PrActions' `merge`. All in place: the button's transitions, pop and burst need the same elements throughout. */
    const merge = () => {
      const el = split();
      if (!el || phase !== "idle" || offer()) return;
      phase = "merging";
      fillMs = 0;
      el.dataset.phase = phase;
      el.classList.remove("ma-pr-tone-ready", "ma-pr-inviting");
      el.classList.add("ma-pr-tone-queued", "ma-pr-filling");
      el.querySelector<HTMLButtonElement>("[data-pr-merge]")!.disabled = true;
      el.querySelector<HTMLButtonElement>(".ma-pr-caret")!.disabled = true;
      el.querySelector("[data-pr-label]")!.textContent = "Merging…";
      root.querySelector("[data-pr-tick]")?.remove();
      ctx.after(MERGE_MS, () => {
        phase = "merged";
        el.dataset.phase = phase;
        el.classList.remove("ma-pr-tone-queued", "ma-pr-filling");
        el.classList.add("ma-pr-tone-merged");
        el.querySelector<HTMLElement>("[data-pr-merge]")!.style.setProperty("--merge-fill", "1");
        el.querySelector("[data-pr-label]")!.textContent = "Merged";
        // `mergedHere`: the header says so before the next poll does, while the badge and checks wait for it.
        const state = root.querySelector<HTMLElement>("[data-pr-state]");
        if (state) {
          state.textContent = "Merged";
          state.className = "ma-pr-state-merged";
          state.parentElement!.querySelector("svg")!.outerHTML = icon("git-merge", 14);
        }
        burst(el.querySelector<HTMLElement>(".ma-pr-burst"), MERGED_BURST);
        toasts.show(`Merged #${NUMBER}`);
        // `fetchPrs` after the hold: the footer goes, the badge turns. The workspace stays, its tick being unticked.
        ctx.later(MERGED_HOLD_MS, () => {
          merged = true;
        });
      });
    };

    const terminal = () => {
      const live =
        status === "thinking" || status === "working"
          ? [`<span class="o">${["✶", "✻", "✽", "✻"][tick % 4]} ${status === "thinking" ? "Thinking" : "Composing"}… <span class="d">(${secs}s · esc to interrupt)</span></span>`, ""]
          : [];
      return [...log, ...live, `<span class="d">&gt;</span> ${cursor(true)}`].slice(-38).join("\n");
    };

    return {
      render: () => ({
        projects: [
          {
            id: "harbor",
            name: "harbor",
            color: "cyan",
            selected: true,
            workspaces: [
              { id: "harbor-local", name: "local", branch: "main", isMain: true, active: false, indicator: null },
              { id: "tide-tables", name: "tide-tables", branch: "tide-tables", isMain: false, active: true, indicator: toWorkspaceIndicator({ status, pulse: false }), diffStats: { added: 40, removed: 3 }, badge: prBadge() },
              { id: "dock-fees", name: "dock-fees", branch: "dock-fees", isMain: false, active: false, indicator: null, badge: badge("pending", "pending", "clock", 209) },
            ],
          },
        ],
        agentGroups: [{ project: "harbor", agents: [{ id: "agent", title: AGENT, status, pulse: false }] }],
        unread: false,
        crumbs: ["harbor", "tide-tables"],
        main: tabbedPanel(
          [{ id: "tide-tables", title: AGENT, active: true, status, pulse: false }],
          leafPane({ id: "agent", title: AGENT, focused: true, hasChat: true, body: terminal() }),
        ),
        overlay: `<div class="ma-pr-layer">${cardOpen ? card() : ""}</div>${toasts.html()}`,
      }),
      drawn: () => {
        place();
        bindCard();
        const trigger = root.querySelector<HTMLElement>("[data-pr-badge]");
        trigger?.addEventListener("mouseenter", hoverOpen);
        trigger?.addEventListener("mouseleave", hoverLeave);
      },
      onClick: (e) => {
        const t = e.target as Element | null;
        if (!t || !root.contains(t)) return;
        if (t.closest("[data-pr-fix]")) return fixChecks();
        if (t.closest("[data-pr-merge]")) return merge();
        // The app's badge also opens the PR on GitHub, which would take the visitor off the page.
        if (t.closest("[data-pr-badge]")) {
          hover++;
          showCard();
        }
      },
      onFrame: ({ ms }) => {
        if (phase === "merging") {
          fillMs += ms;
          // lib/merge-fill.ts `mergeFillAt`.
          root.querySelector<HTMLElement>("[data-pr-merge]")?.style.setProperty("--merge-fill", String(fillMs / (fillMs + FILL_HALFWAY_MS)));
        }
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
