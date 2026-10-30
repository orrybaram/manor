import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock";
import Play from "lucide-react/dist/esm/icons/play";
import Plus from "lucide-react/dist/esm/icons/plus";
import type { AutomationView } from "../../lib/automation-views";
import { requestUi } from "../../utils/ui-request";
import { toast } from "../../toast";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import {
  currentHosts,
  errorText,
  type AutomationHost,
} from "../settings/AutomationsPage/useAutomations";
import type { CommandItem } from "./types";
import styles from "./CommandPalette.module.css";

const NO_PROJECTS: ProjectInfo[] = [];

interface HostAutomations {
  host: AutomationHost;
  automations: AutomationView[];
}

/**
 * Every automation of each host that is up. One asleep or away is not
 * asked (a read must not wake it), and one that can't answer is left out.
 */
async function listAll(): Promise<HostAutomations[]> {
  const hosts = currentHosts().filter(
    (h) => h.local || h.status === "connected",
  );
  const lists = await Promise.all(
    hosts.map((host) =>
      window.electronAPI.automations.list(host.hostId).then(
        (automations) => ({ host, automations }),
        () => ({ host, automations: [] }),
      ),
    ),
  );
  return lists.filter((l) => l.automations.length > 0);
}

interface UseAutomationCommandsParams {
  onClose: () => void;
  /** Only list automations of these projects; `null` lists all. */
  scopeProjectIds: ReadonlySet<string> | null;
  /** Whether the palette is open. While closed no host is asked. */
  enabled: boolean;
}

/**
 * The Automations group: New Automation, then each automation, to open its
 * page in Settings → Automations or run it now. Read afresh each time the
 * palette opens.
 */
export function useAutomationCommands({
  onClose,
  scopeProjectIds,
  enabled,
}: UseAutomationCommandsParams): CommandItem[] {
  const projects = useProjectStore((s) => (enabled ? s.projects : NO_PROJECTS));
  const { data: lists } = useQuery({
    queryKey: ["palette-automations"],
    queryFn: listAll,
    enabled,
    staleTime: 0,
    retry: false,
  });

  return useMemo(() => {
    const items: CommandItem[] = [
      {
        id: "new-automation",
        label: "New Automation",
        icon: <Plus size={14} />,
        keywords: ["automation", "schedule", "cron", "create"],
        action: () => {
          onClose();
          requestUi({ type: "new-automation" });
        },
      },
    ];

    for (const { host, automations } of lists ?? []) {
      // This computer's go untagged; another host's carry its name.
      const suffix = host.local ? undefined : (
        <span className={styles.projectTag}>{host.name}</span>
      );
      for (const automation of automations) {
        if (scopeProjectIds && !scopeProjectIds.has(automation.projectId))
          continue;
        const project = projects.find(
          (p) => p.id === automation.projectId,
        )?.name;
        const keywords = [
          "automation",
          ...(project ? [project] : []),
          ...(host.local ? [] : [host.name]),
        ];
        const key = `${host.hostId}:${automation.id}`;
        items.push(
          {
            id: `automation-${key}`,
            label: automation.name,
            icon: <CalendarClock size={14} />,
            keywords,
            suffix,
            action: () => {
              onClose();
              requestUi({
                type: "open-automation",
                hostId: host.hostId,
                automationId: automation.id,
              });
            },
          },
          {
            id: `automation-run-${key}`,
            label: `Run Now: ${automation.name}`,
            icon: <Play size={14} />,
            keywords: [...keywords, "run", "start", "fire"],
            suffix,
            action: () => {
              onClose();
              window.electronAPI.automations
                .runNow(host.hostId, automation.id)
                .then(
                  () => toast.success(`Started ${automation.name}`),
                  (err: unknown) =>
                    toast.error(`Couldn't run ${automation.name}`, {
                      detail: errorText(err),
                    }),
                );
            },
          },
        );
      }
    }
    return items;
  }, [lists, projects, scopeProjectIds, onClose]);
}
