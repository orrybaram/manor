import { useCallback, useId, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { useHostStore } from "../../store/host-store";
import { hostLabel, isRemoteHost } from "../../lib/hosts";
import type { TransferInputReason } from "../../electron";
import type { CloneHostChoice } from "../../lib/workspace-host-choices";
import { toDirSlug } from "../../utils/branch-name";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { Row, Stack } from "../ui/Layout/Layout";
import { ToggleGroup } from "../ui/ToggleGroup";
import { HostIndicator } from "./HostIndicator";
import { pickDirectory } from "../../lib/pick-directory";
import { RepoUrlAndRemoteDirFields } from "./HostCloneSteps";
import styles from "./HostCloneSteps.module.css";

/**
 * What each mode does with the clone: the dialog's title, the submit label,
 * and how the hint ends. Submit hands off to the store (`setUpOnHost` or, for
 * the repair path, `transferProject`) and closes. Both never throw and report
 * through a progress toast, whose "Choose location…" action (or a `needsInput`
 * result) reopens this dialog, so there is no in-dialog progress to keep.
 * - `setUp`: ADR-214's one verb, "Set up on". Clone or adopt on the host, then
 *   join the project there.
 * - `move`: only the repair path, re-cloning a missing repo on its own host.
 */
const MODES = {
  setUp: {
    title: (name: string, host: string) => `Set up ${name} on ${host}`,
    submit: "Set up",
    outcome: (name: string) => `it will be set up as another host of "${name}"`,
  },
  move: {
    title: () => "Clone it again",
    submit: "Clone",
    outcome: (name: string) => `"${name}" will then run from it`,
  },
} as const;

/** The banner for why the dialog opened, or null when it needs none. */
export function reasonBanner(reason: CloneToHostReason | undefined, error?: string): string | null {
  switch (reason) {
    case "no-origin":
      return "This project has no origin remote — enter the repo URL.";
    case "dir-taken":
      return "That folder is already used — pick another.";
    case "host-taken":
      return "This project is already on that host — pick another.";
    case "failed":
      return error
        ? `The clone failed — check the location and try again. ${error}`
        : "The clone failed — check the location and try again.";
    default:
      return null;
  }
}

export type CloneToHostReason = TransferInputReason | "failed" | "manual";

type CloneToHostDialogProps = {
  open: boolean;
  project: ProjectInfo;
  mode?: keyof typeof MODES;
  /**
   * The hosts to clone onto, at least one. With one the host is fixed;
   * with more the user chooses, starting on `initialHostId` or the first
   * available.
   */
  hostChoices: CloneHostChoice[];
  initialHostId?: string;
  initialRepoUrl?: string | null;
  initialDir?: string;
  /** Why the dialog opened; shows a banner. */
  reason?: CloneToHostReason;
  /** The thrown message for `reason: "failed"`. */
  error?: string;
  onClose: () => void;
  /**
   * Called with the host once a `setUp` submit has finished, successfully or
   * not: the caller checks the store for the new project.
   */
  onSetUp?: (hostId: string) => void;
  /** Where focus goes once the dialog has closed; Radix's default when omitted. */
  onCloseAutoFocus?: (e: Event) => void;
};

/**
 * Set-up-on-host form for an EXISTING project (ADR-214). See `MODES` for
 * what it does with the clone.
 *
 * Its state starts fresh on mount, so mount one instance per opening (a
 * conditional mount, or a new `key`). Keep it mounted with `open` false to
 * let the exit animation play.
 */
export function CloneToHostDialog(props: CloneToHostDialogProps) {
  const {
    open,
    project,
    mode = "setUp",
    hostChoices,
    initialHostId,
    initialRepoUrl,
    initialDir,
    reason,
    error: failure,
    onClose,
    onSetUp,
    onCloseAutoFocus,
  } = props;

  const { title, submit, outcome } = MODES[mode];
  const setUpOnHost = useProjectStore((s) => s.setUpOnHost);
  const transferProject = useProjectStore((s) => s.transferProject);
  const hosts = useHostStore((s) => s.hosts);
  const hostChoiceLabelId = useId();

  const [hostId, setHostId] = useState(
    () =>
      hostChoices.find((c) => c.hostId === initialHostId)?.hostId ??
      (hostChoices.find((c) => !c.disabledReason) ?? hostChoices[0])?.hostId ??
      "",
  );
  const [repoUrl, setRepoUrl] = useState(initialRepoUrl ?? "");
  const [remoteDir, setRemoteDir] = useState(
    () => initialDir || `~/code/${toDirSlug(project.name)}`,
  );
  const isLocal = !isRemoteHost(hostId);
  const banner = reasonBanner(reason, failure);
  const hostName = hostLabel(hostId, hosts);
  const hostUnavailable = hostChoices.find((c) => c.hostId === hostId)?.disabledReason ?? null;

  // Pre-fill the repo URL from the project's current `origin`, unless the
  // opener already planned one.
  useMountEffect(() => {
    if (initialRepoUrl) return;
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
      if (!isOpen) onClose();
    },
    [onClose],
  );

  const handleUseExistingFolder = useCallback(async () => {
    const picked = await pickDirectory();
    if (picked) setRemoteDir(picked);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!repoUrl.trim() || !remoteDir.trim() || hostUnavailable) return;
    const overrides = { repoUrl: repoUrl.trim(), targetDir: remoteDir.trim() };
    onClose();
    if (mode === "setUp") {
      await setUpOnHost(project.id, hostId, overrides);
      onSetUp?.(hostId);
      return;
    }
    void transferProject(project.id, hostId, mode, overrides);
  }, [
    repoUrl,
    remoteDir,
    hostUnavailable,
    mode,
    onClose,
    setUpOnHost,
    transferProject,
    project.id,
    hostId,
    onSetUp,
  ]);

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
            <Dialog.Title className={styles.title}>{title(project.name, hostName)}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </Row>
          <Stack className={styles.body}>
            <Stack gap="sm">
              {banner && (
                <div className={styles.fieldHint} data-testid="clone-to-host-banner">
                  {banner}
                </div>
              )}
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
                local={isLocal}
              />
              <div className={styles.fieldHint}>
                The repo will be cloned on {hostName} — or an existing clone there will be adopted —
                and {outcome(project.name)}.
                {!isLocal && " Manor doesn't copy your keys; log in on the box first."}
              </div>
              {hostUnavailable && <div className={styles.error}>{hostUnavailable}</div>}
              {isLocal && (
                <Row>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleUseExistingFolder}
                    data-testid="clone-to-host-use-existing-folder"
                  >
                    Use an existing folder…
                  </Button>
                </Row>
              )}
              <Row gap="sm" justify="flex-end">
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!repoUrl.trim() || !remoteDir.trim() || !!hostUnavailable}
                  onClick={handleSubmit}
                >
                  {submit}
                </Button>
              </Row>
            </Stack>
          </Stack>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
