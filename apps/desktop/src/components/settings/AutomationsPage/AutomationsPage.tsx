import { useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useAgentStore } from "../../../store/agent-store";
import { useProjectStore } from "../../../store/project-store";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { toast } from "../../../toast";
import { Button } from "../../ui/Button/Button";
import { SectionTitle } from "../SectionTitle";
import { AutomationList } from "./AutomationList";
import { ExistingAutomation, NewAutomation } from "./AutomationEditor";
import { newDraft } from "./draft";
import { useAutomationHosts, useAutomationLists } from "./useAutomations";
import styles from "./AutomationsPage.module.css";

type View =
  | { kind: "list" }
  /** `linked`: opened from outside the page, so a stale one falls back to the list. */
  | { kind: "detail"; hostId: string; id: string; linked?: boolean }
  | { kind: "new" };

/** An automation to open the page on, e.g. from a bell row; `new` opens a new one. */
export type AutomationTarget = { hostId: string; automationId: string } | "new";

type AutomationsPageProps = {
  /** Closes Settings: opening a run's agent leaves for its pane. */
  onClose?: () => void;
  /**
   * Opens this automation's page, when it is set and each time a new one is
   * passed; the list when that host has no such automation.
   */
  target?: AutomationTarget | null;
};

function viewOf(target: AutomationTarget | null | undefined): View {
  if (!target) return { kind: "list" };
  if (target === "new") return { kind: "new" };
  return { kind: "detail", hostId: target.hostId, id: target.automationId, linked: true };
}

/**
 * Settings → Automations: every host's automations in one list, and each
 * one's own page — its schedule and target as a sentence of chips, its
 * prompt and its runs — in the same content area. New opens that page
 * empty.
 */
export function AutomationsPage(props: AutomationsPageProps) {
  const { onClose, target } = props;
  const [view, setView] = useState<View>(() => viewOf(target));
  const [shownTarget, setShownTarget] = useState(target);
  if (target !== shownTarget) {
    setShownTarget(target);
    if (target) setView(viewOf(target));
  }
  const hosts = useAutomationHosts();
  // Under an automation's page the list waits: it re-reads on its own changes only.
  const lists = useAutomationLists({ paused: view.kind !== "list" });
  const projects = useProjectStore((s) => s.projects);

  // Only a host whose server keeps automations can take a new one.
  const usable = hosts.filter((h) => lists[h.hostId]?.kind === "ready");

  const openAgent = async (agentId: string) => {
    const known = useAgentStore.getState().agents.find((a) => a.id === agentId);
    const agent = known ?? (await window.electronAPI.agents.get(agentId).catch(() => null));
    if (!agent) {
      toast.info("That run's agent is gone");
      return;
    }
    onClose?.();
    navigateToAgent(agent);
  };

  if (view.kind === "detail") {
    return (
      <ExistingAutomation
        key={`${view.hostId}:${view.id}`}
        hostId={view.hostId}
        id={view.id}
        hosts={hosts}
        onBack={() => setView({ kind: "list" })}
        onMissing={view.linked ? () => setView({ kind: "list" }) : undefined}
        onOpenAgent={(id) => void openAgent(id)}
      />
    );
  }

  if (view.kind === "new" && usable.length > 0) {
    const host = usable.find((h) => projects.some((p) => p.hostId === h.hostId)) ?? usable[0];
    return (
      <NewAutomation
        initial={newDraft(host, projects)}
        hosts={usable}
        onBack={() => setView({ kind: "list" })}
        onOpenAgent={(id) => void openAgent(id)}
        onCreated={(hostId, id) => setView({ kind: "detail", hostId, id })}
      />
    );
  }

  return (
    <div className={styles.page} data-testid="automations-page">
      <div className={styles.header}>
        <SectionTitle id="automations-list">Automations</SectionTitle>
        <Button
          variant="primary"
          size="sm"
          data-testid="automation-new"
          disabled={usable.length === 0}
          onClick={() => setView({ kind: "new" })}
        >
          <Plus size={12} aria-hidden className={styles.buttonIcon} />
          New automation
        </Button>
      </div>
      <div className={styles.description}>
        Agents that start on a schedule. Remote hosts run them with this app closed.
      </div>
      <AutomationList
        hosts={hosts}
        lists={lists}
        onOpen={(hostId, id) => setView({ kind: "detail", hostId, id })}
      />
    </div>
  );
}
