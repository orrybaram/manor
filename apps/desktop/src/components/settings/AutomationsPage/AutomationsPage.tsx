import { useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useAgentStore } from "../../../store/agent-store";
import { useProjectStore } from "../../../store/project-store";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { toast } from "../../../toast";
import { Button } from "../../ui/Button/Button";
import { SectionTitle } from "../SectionTitle";
import { AutomationList } from "./AutomationList";
import { ExistingAutomation, NewAutomation, newDraft } from "./AutomationEditor";
import { useAutomationHosts, useAutomationLists } from "./useAutomations";
import styles from "./AutomationsPage.module.css";

type View =
  | { kind: "list" }
  | { kind: "detail"; hostId: string; id: string }
  | { kind: "new" };

type AutomationsPageProps = {
  /** Closes Settings: opening a run's agent leaves for its pane. */
  onClose?: () => void;
};

/**
 * Settings → Automations: every host's automations in one list, and each
 * one's own page — its schedule and target as a sentence of chips, its
 * prompt and its runs — in the same content area. New opens that page
 * empty.
 */
export function AutomationsPage(props: AutomationsPageProps) {
  const { onClose } = props;
  const [view, setView] = useState<View>({ kind: "list" });
  const hosts = useAutomationHosts();
  const lists = useAutomationLists();
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
