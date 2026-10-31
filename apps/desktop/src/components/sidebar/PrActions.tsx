import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import Bot from "lucide-react/dist/esm/icons/bot";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Check from "lucide-react/dist/esm/icons/check";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle";
import { Button } from "../ui/Button/Button";
import { Checkbox } from "../ui/Checkbox/Checkbox";
import type {
  PrAgentTask,
  PrInfo,
  PrMergeMethod,
  PrMergeOutcome,
} from "../../lib/pr-info";
import { mergeOffer } from "../../lib/pr-merge-offer";
import { ghRepoOf } from "../../lib/gh-repo";
import { ownerOf } from "../../lib/workspace-directory";
import { workspaceKey } from "../../lib/workspace-key";
import { deleteWorkspaceWhenMerged } from "../../lib/merge-cleanup";
import { layoutKeyFor } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { usePreferencesStore } from "../../store/preferences-store";
import { removeWorktreeWithToast } from "../../store/workspace-actions";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { fetchPrs } from "../../hooks/usePrWatcher";
import { toast } from "../../toast";
import styles from "./PrActions.module.css";

const METHOD_LABEL: Record<PrMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge",
  rebase: "Rebase and merge",
};

const METHOD_MENU: Record<PrMergeMethod, { label: string; detail: string }> = {
  squash: { label: "Squash and merge", detail: "One commit on the base branch" },
  merge: { label: "Create a merge commit", detail: "Every commit, joined by a merge commit" },
  rebase: { label: "Rebase and merge", detail: "Every commit, replayed onto the base" },
};

/** How long the merged moment plays before the workspace goes. */
const MERGED_HOLD_MS = 1300;

type Phase = "idle" | "merging" | PrMergeOutcome;

/**
 * The PR card's footer: hand the failing checks or the unresolved review
 * threads to the workspace's agent, and merge. Shared by the desk hover card
 * and the phone's PR sheet through `PrDetails`.
 */
export function PrActions(props: {
  pr: PrInfo;
  workspacePath: string;
  hostId?: string;
  /** Called before an action takes the user elsewhere, e.g. to close a popover. */
  onLeave?: () => void;
}) {
  const { pr, workspacePath, hostId, onLeave } = props;
  const phone = useLayoutMode() === "phone";
  const project = useProjectStore((s) => ownerOf(s.projects, layoutKeyFor(workspacePath, hostId)));
  const ws = project?.workspaces.find((w) => w.path === workspacePath);
  const deleteAfter = usePreferencesStore((s) => s.preferences.deleteWorkspaceAfterMerge);
  const setPreference = usePreferencesStore((s) => s.set);

  const repo = project ? ghRepoOf(project) : null;
  const isOpen = pr.state === "open";
  const options = useQuery({
    queryKey: ["prMergeOptions", repo?.hostId, repo?.path, pr.number],
    queryFn: () => window.electronAPI.github.getMergeOptions(repo!, pr.number),
    enabled: repo != null && isOpen && !pr.queuedToMerge,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const [phase, setPhase] = useState<Phase>("idle");
  const [method, setMethod] = useState<PrMergeMethod | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [briefing, setBriefing] = useState<PrAgentTask | null>(null);
  const burstRef = useRef<HTMLSpanElement>(null);

  const failing = pr.checks?.failing ?? 0;
  const threads = pr.unresolvedThreads ?? 0;
  const chosen = method ?? options.data?.allowed[0] ?? "squash";

  const brief = useCallback(
    async (task: PrAgentTask) => {
      if (!repo) return;
      setBriefing(task);
      const what = task === "checks" ? "the failing checks" : "the review comments";
      try {
        const prompt = await window.electronAPI.github.getPrAgentPrompt(repo, pr.number, task);
        onLeave?.();
        // Loaded on click: the agent store it reads is not one the card needs to show.
        const { briefWorkspaceAgent } = await import("../../lib/brief-agent");
        const delivery = await briefWorkspaceAgent(workspacePath, prompt, hostId);
        toast.success(
          delivery.kind === "sent"
            ? `Sent ${what} to ${delivery.agentName}`
            : `Started an agent on ${what}`,
        );
      } catch (err) {
        toast.error(`Couldn't brief an agent on ${what}`, { error: err });
      } finally {
        setBriefing(null);
      }
    },
    [repo, pr.number, workspacePath, hostId, onLeave],
  );

  const optionsError = options.error ? String((options.error as Error).message ?? options.error) : null;
  useEffect(() => {
    if (optionsError) toast.error(`Couldn't read how #${pr.number} can merge`, { detail: optionsError });
  }, [optionsError, pr.number]);
  const offer = useMemo(
    () =>
      !isOpen || pr.queuedToMerge
        ? null
        : optionsError
          ? ({ kind: "none", reason: "Couldn't read the repo's merge settings" } as const)
          : mergeOffer(pr, options.data),
    [isOpen, pr, optionsError, options.data],
  );
  const canDelete = ws != null && !ws.isMain;

  const merge = useCallback(async () => {
    if (!repo || !project || !offer || offer.kind === "none" || phase !== "idle") return;
    setPhase("merging");
    let outcome: PrMergeOutcome;
    try {
      outcome = await window.electronAPI.github.mergePr(repo, pr.number, chosen, offer.kind === "auto");
    } catch (err) {
      setPhase("idle");
      toast.error(`Couldn't merge #${pr.number}`, { error: err });
      return;
    }
    setPhase(outcome);
    const deleting = deleteAfter && canDelete && ws;
    if (outcome === "merged") {
      burst(burstRef.current);
      toast.success(`Merged #${pr.number}`);
      // Not cancelled if the card closes meanwhile: the workspace must still go.
      setTimeout(() => {
        void fetchPrs();
        if (deleting) {
          onLeave?.();
          void removeWorktreeWithToast(project, ws, true);
        }
      }, MERGED_HOLD_MS);
      return;
    }
    if (deleting) deleteWorkspaceWhenMerged(workspaceKey(project.hostId, ws.path), pr.url);
    const then = deleting ? `; "${ws.name || ws.branch}" goes once it merges` : "";
    toast.success(
      outcome === "queued"
        ? `Added #${pr.number} to the merge queue${then}`
        : `Auto-merge armed on #${pr.number}${then}`,
    );
    void fetchPrs();
  }, [repo, project, offer, phase, pr.number, pr.url, chosen, deleteAfter, canDelete, ws, onLeave]);

  if (!repo || !isOpen) return null;
  const showAgents = failing > 0 || threads > 0;
  if (!showAgents && !offer && !pr.queuedToMerge) return null;

  const label =
    phase === "merged"
      ? "Merged"
      : phase === "queued"
        ? "Queued to merge"
        : phase === "auto"
          ? "Merges when ready"
          : phase === "merging"
            ? "Merging…"
            : offer?.kind === "queue"
              ? "Add to merge queue"
              : offer?.kind === "auto"
                ? "Merge when ready"
                : METHOD_LABEL[chosen];

  const settled = phase === "queued" || phase === "auto" || (pr.queuedToMerge && phase === "idle");
  const disabled = phase !== "idle" || !offer || offer.kind === "none";
  const tone =
    phase === "merged"
      ? styles.merged
      : settled || offer?.kind === "queue" || offer?.kind === "auto" || phase === "merging"
        ? styles.queued
        : offer?.kind === "merge"
          ? styles.ready
          : styles.unavailable;
  // The glint and glow say "this one merges now"; nothing else earns them.
  const inviting = phase === "idle" && offer?.kind === "merge";
  const hasMenu = offer?.kind === "merge" || offer?.kind === "auto";
  const allowed = options.data?.allowed ?? [];

  const agentButtons = showAgents && (
    <span className={styles.agents}>
      {failing > 0 && (
        <Button
          size="sm"
          className={styles.agentButton}
          disabled={briefing !== null}
          onClick={() => void brief("checks")}
          title="Send the failing checks and their logs to this workspace's agent"
          data-testid="pr-fix-checks"
        >
          {briefing === "checks" ? <LoaderCircle size={12} className={styles.spin} /> : <Bot size={12} />}
          Fix checks
        </Button>
      )}
      {threads > 0 && (
        <Button
          size="sm"
          className={styles.agentButton}
          disabled={briefing !== null}
          onClick={() => void brief("comments")}
          title="Send the unresolved review comments to this workspace's agent"
          data-testid="pr-address-comments"
        >
          {briefing === "comments" ? <LoaderCircle size={12} className={styles.spin} /> : <Bot size={12} />}
          Address {threads} {threads === 1 ? "comment" : "comments"}
        </Button>
      )}
    </span>
  );

  const deleteTick = canDelete && offer && offer.kind !== "none" && phase === "idle" && (
    <label className={styles.tick}>
      <Checkbox
        size={phone ? "md" : "sm"}
        checked={deleteAfter}
        onCheckedChange={(v) => setPreference("deleteWorkspaceAfterMerge", v === true)}
        data-testid="pr-delete-after-merge"
      />
      Delete workspace after merge
    </label>
  );

  const mergeButton = (offer || pr.queuedToMerge) && (
    <span
      className={`${styles.split} ${tone}${inviting ? ` ${styles.inviting}` : ""}${phase === "merging" ? ` ${styles.filling}` : ""}`}
      data-phase={phase}
      data-offer={offer?.kind ?? "queued"}
    >
      <button
        type="button"
        className={styles.main}
        disabled={disabled}
        onClick={() => void merge()}
        title={offer?.kind === "none" ? offer.reason : undefined}
        data-testid="pr-merge"
      >
        <MergeGlyph />
        <span>{label}</span>
      </button>
      {hasMenu && (
        <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className={styles.caret}
              disabled={disabled || allowed.length < 2}
              aria-label="Choose how to merge"
              data-testid="pr-merge-method"
            >
              <ChevronDown size={12} />
            </button>
          </Popover.Trigger>
          {/* In place on the desk: portaled, the hover card would read moving
              into the menu as leaving and close. The phone sheet has no hover. */}
          <MenuLayer phone={phone}>
            <Popover.Content
              className={styles.menu}
              side="top"
              align="end"
              sideOffset={6}
              role="menu"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {allowed.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m === chosen}
                  className={styles.menuItem}
                  onClick={() => {
                    setMethod(m);
                    setMenuOpen(false);
                  }}
                  data-testid={`pr-merge-method-${m}`}
                >
                  <span className={styles.menuCheck}>{m === chosen && <Check size={11} />}</span>
                  <span>
                    {METHOD_MENU[m].label}
                    {m === allowed[0] && <span className={styles.menuDefault}> · repo default</span>}
                    <small>{METHOD_MENU[m].detail}</small>
                  </span>
                </button>
              ))}
            </Popover.Content>
          </MenuLayer>
        </Popover.Root>
      )}
      <span ref={burstRef} className={styles.burst} aria-hidden="true" />
    </span>
  );

  // Said in words, not only in the button's tooltip: a phone has no hover.
  // Not while the settings are still loading: that is a wait, not a reason.
  const reason =
    phase === "idle" && offer?.kind === "none" && (options.data !== undefined || optionsError)
      ? offer.reason
      : undefined;

  return (
    <div className={`${styles.footer}${phone ? ` ${styles.phone}` : ""}`} data-testid="pr-actions">
      {agentButtons ? (
        <>
          <div className={styles.row}>
            {agentButtons}
            <span className={styles.spacer} />
            {mergeButton}
          </div>
          {deleteTick && <div className={styles.row}>{deleteTick}</div>}
          {reason && <div className={styles.reason} data-testid="pr-merge-reason">{reason}</div>}
        </>
      ) : (
        <div className={styles.row}>
          {deleteTick}
          <span className={styles.spacer} />
          {mergeButton}
        </div>
      )}
      {!agentButtons && reason && (
        <div className={styles.reason} data-testid="pr-merge-reason">{reason}</div>
      )}
    </div>
  );
}

function MenuLayer(props: { phone: boolean; children: React.ReactNode }) {
  return props.phone ? <Popover.Portal>{props.children}</Popover.Portal> : <Fragment>{props.children}</Fragment>;
}

/** The merge icon, its two branches drawn apart so a merge can snap them together. */
function MergeGlyph() {
  return (
    <svg
      className={styles.glyph}
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g className={styles.zipA}>
        <circle cx="6" cy="6" r="3" />
        <path d="M6 9v12" />
      </g>
      <g className={styles.zipB}>
        <circle cx="18" cy="18" r="3" />
        <path d="M15 18a9 9 0 0 1-9-9" />
      </g>
    </svg>
  );
}

const BURST_FLECKS = 26;

/** Flecks in the theme's colours spray off the button and fall away. */
function burst(host: HTMLElement | null): void {
  if (!host || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const css = getComputedStyle(host);
  const colours = ["--accent", "--magenta", "--yellow", "--green"].map(
    (name) => css.getPropertyValue(name).trim() || "currentColor",
  );
  for (let i = 0; i < BURST_FLECKS; i++) {
    const fleck = document.createElement("i");
    fleck.style.background = colours[i % colours.length];
    fleck.style.left = `${20 + Math.random() * 60}%`;
    host.append(fleck);
    const angle = -Math.PI * Math.random();
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
