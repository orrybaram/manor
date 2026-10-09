import { useCallback, useId, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { useHostStore } from "../../store/host-store";
import { hostLabel } from "../../lib/hosts";
import type { CloneHostChoice } from "../../lib/workspace-host-choices";
import { toDirSlug } from "../../utils/branch-name";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { Row, Stack } from "../ui/Layout/Layout";
import { ToggleGroup } from "../ui/ToggleGroup";
import { HostIndicator } from "./HostIndicator";
import { useHostCloneFlow } from "./useHostCloneFlow";
import { CloneError, HostCloneSteps, RepoUrlAndRemoteDirFields } from "./HostCloneSteps";
import styles from "./HostCloneSteps.module.css";

/**
 * What each mode does with the clone: which store action runs it, the
 * dialog's title, and how the hint ends.
 * - `move`: the project itself moves onto the host (ADR-179).
 * - `addToGroup`: the clone is a new project, linked into the project's
 *   group (ADR-192 ticket 4).
 */
const MODES = {
  move: {
    action: "moveProjectToHost",
    title: "Clone onto host",
    outcome: (name: string) => `"${name}" will then run from it`,
  },
  addToGroup: {
    action: "cloneIntoGroup",
    title: "Clone onto another host",
    outcome: (name: string) => `it will be linked to "${name}" as another host`,
  },
} as const;

type CloneToHostDialogProps = {
  open: boolean;
  project: ProjectInfo;
  mode?: keyof typeof MODES;
  /**
   * The hosts to clone onto, at least one. With one the host is fixed;
   * with more the user chooses, starting on the first available.
   */
  hostChoices: CloneHostChoice[];
  onClose: () => void;
  /** Called with the resulting project once the clone succeeded. */
  onCloned?: (project: ProjectInfo) => void;
  /** Where focus goes once the dialog has closed; Radix's default when omitted. */
  onCloseAutoFocus?: (e: Event) => void;
};

/**
 * Clone-onto-host flow for an EXISTING project, reusing the same
 * form → cloning → health steps as `AddProjectDialog`'s remote flow via
 * `useHostCloneFlow` (ADR-183 ticket 10). See `MODES` for what it does with
 * the clone.
 *
 * Its state starts fresh on mount, so mount one instance per opening (a
 * conditional mount, or a new `key`). Keep it mounted with `open` false to
 * let the exit animation play.
 */
export function CloneToHostDialog(props: CloneToHostDialogProps) {
  const { open, project, mode = "move", hostChoices, onClose, onCloned, onCloseAutoFocus } =
    props;

  const { action, title, outcome } = MODES[mode];
  const run = useProjectStore((s) => s[action]);
  const hosts = useHostStore((s) => s.hosts);
  const hostChoiceLabelId = useId();

  const [hostId, setHostId] = useState(
    () => (hostChoices.find((c) => !c.disabledReason) ?? hostChoices[0])?.hostId ?? "",
  );
  const [repoUrl, setRepoUrl] = useState("");
  const [remoteDir, setRemoteDir] = useState(() => `~/code/${toDirSlug(project.name)}`);
  const hostName = hostLabel(hostId, hosts);
  const hostUnavailable = hostChoices.find((c) => c.hostId === hostId)?.disabledReason ?? null;

  const flow = useHostCloneFlow({
    hostId,
    run: () => run(project.id, { hostId, repoUrl: repoUrl.trim(), remoteDir: remoteDir.trim() }),
  });

  // Pre-fill the repo URL from the project's current `origin`.
  useMountEffect(() => {
    let cancelled = false;
    window.electronAPI.projects
      .getOriginUrl(project.id)
      .then((url) => {
        if (url && !cancelled) setRepoUrl(url);
      })
      .catch(() => {
        /* leave the field blank — the user can type it in */
      });
    return () => {
      cancelled = true;
    };
  });

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && flow.step !== "cloning") {
        onClose();
      }
    },
    [onClose, flow.step],
  );

  const handleClone = useCallback(async () => {
    if (!repoUrl.trim() || !remoteDir.trim() || hostUnavailable) return;
    const cloned = await flow.start();
    if (cloned) onCloned?.(cloned);
  }, [repoUrl, remoteDir, hostUnavailable, flow, onCloned]);

  const handleFixInTerminal = useCallback(
    (check: Parameters<typeof flow.fix>[0]) => {
      flow.fix(check);
      // The terminal tab renders behind this dialog otherwise — close it so
      // the user lands where the command was typed.
      onClose();
    },
    [flow, onClose],
  );

  const handleDone = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          data-testid="clone-to-host-dialog"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <Row align="center" justify="space-between" className={styles.header}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </Row>
          <Stack className={styles.body}>
            {flow.step === "form" && (
              <Stack gap="sm">
                {hostChoices.length > 1 ? (
                  <Stack>
                    <span className={styles.fieldLabel} id={hostChoiceLabelId}>
                      Host
                    </span>
                    <ToggleGroup
                      value={hostId}
                      onChange={setHostId}
                      size="sm"
                      aria-labelledby={hostChoiceLabelId}
                      data-testid="clone-to-host-host-choice"
                      options={hostChoices.map((choice) => ({
                        value: choice.hostId,
                        label: <HostIndicator hostId={choice.hostId} variant="label" />,
                        ...(choice.disabledReason ? { disabledReason: choice.disabledReason } : {}),
                      }))}
                    />
                  </Stack>
                ) : (
                  <Stack>
                    <label className={styles.fieldLabel}>Host</label>
                    <div className={styles.fieldStatic}>{hostName}</div>
                  </Stack>
                )}
                <RepoUrlAndRemoteDirFields
                  idPrefix="clone-to-host"
                  repoUrl={repoUrl}
                  onRepoUrlChange={setRepoUrl}
                  remoteDir={remoteDir}
                  onRemoteDirChange={setRemoteDir}
                />
                <div className={styles.fieldHint}>
                  The repo will be cloned on {hostName} — or an existing clone
                  there will be adopted — and {outcome(project.name)}. Manor
                  doesn't copy your keys; log in on the box first.
                </div>
                {hostUnavailable && <div className={styles.error}>{hostUnavailable}</div>}
                {flow.error && <CloneError message={flow.error} />}
                <Row gap="sm" justify="flex-end">
                  <Button variant="secondary" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!repoUrl.trim() || !remoteDir.trim() || !!hostUnavailable}
                    onClick={handleClone}
                  >
                    Clone
                  </Button>
                </Row>
              </Stack>
            )}

            {(flow.step === "cloning" || flow.step === "health") && (
              <HostCloneSteps
                step={flow.step}
                progressLines={flow.progressLines}
                checks={flow.checks}
                checksRunning={flow.checksRunning}
                onRerun={flow.rerun}
                onFix={handleFixInTerminal}
                onDone={handleDone}
              />
            )}
          </Stack>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
