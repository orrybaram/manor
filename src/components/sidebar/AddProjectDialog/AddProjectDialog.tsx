import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useHostStore } from "../../../store/host-store";
import { addErrorToast } from "../../../store/toast-store";
import { LOCAL_HOST_ID, isRemoteHost, remoteHostOptions } from "../../../lib/hosts";
import type { GitHubRepo } from "../../../electron.d.ts";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { ToggleGroup } from "../../ui/ToggleGroup";
import { Row, Stack } from "../../ui/Layout/Layout";
import { useHostCloneFlow } from "../../hosts/useHostCloneFlow";
import { CloneDirField, HostCloneSteps, RepoUrlField } from "../../hosts/HostCloneSteps";
import styles from "../../hosts/HostCloneSteps.module.css";
import { isWebApp } from "../../../lib/platform";
import { pickDirectory } from "../../../lib/pick-directory";

export type AddProjectMode = "folder" | "clone";

type AddProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Which tab the dialog opens on; "folder" unless the caller asks to clone. */
  initialMode?: AddProjectMode;
  /** "Open folder" picks a directory and adds it; mirrors the old flow. */
  onAddLocal: () => Promise<void>;
  /** Called once a clone onto this machine finishes; the dialog has closed. */
  onLocalProjectCloned?: (project: ProjectInfo) => void;
  /** Called once the remote clone finishes and the project is added. */
  onRemoteProjectAdded?: (project: ProjectInfo) => void;
};

const DEFAULT_CLONE_PARENT = "~/code";

/** A repo URL's last path segment without `.git`, or "" when there is none. */
function repoNameFromUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  return trimmed.split(/[/:]/).pop() ?? "";
}

/** Derive a project name from a repo URL's last path segment. */
function nameFromRepoUrl(repoUrl: string): string {
  return repoNameFromUrl(repoUrl) || "project";
}

/** `path` without its last segment; "/" for a top-level path. */
function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx > 0 ? trimmed.slice(0, idx) : "/";
}

/** `name` inside `dir`, without doubling a trailing slash. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * "Add Project" offers two things to do (ADR-194): open a folder already on
 * this machine (the pre-ADR-178 flow), or clone a repo onto any host — this
 * machine or a remote one (ADR-178 ticket 5). The repo can be picked from the
 * user's GitHub repos (via `gh`) or pasted as a URL. The clone's form →
 * cloning → health state machine is shared with `CloneToHostDialog` via
 * `useHostCloneFlow` (ADR-183 ticket 10); a local clone skips the health step
 * and hands off to `ProjectSetupWizard`, like "Open folder" does.
 */
export function AddProjectDialog(props: AddProjectDialogProps) {
  const {
    open,
    onClose,
    initialMode = "folder",
    onAddLocal,
    onLocalProjectCloned,
    onRemoteProjectAdded,
  } = props;

  const [chosenMode, setMode] = useState<AddProjectMode>(initialMode);
  // A browser has no folder picker (ADR-180 D8), so the web app only clones
  // — onto any host, by typed location — and never shows "Open folder".
  const webApp = isWebApp();
  const mode: AddProjectMode = webApp ? "clone" : chosenMode;
  const [addingLocal, setAddingLocal] = useState(false);

  // Each open starts on the tab the caller asked for (the palette's
  // "Clone Repository…" opens straight onto "clone").
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setMode(initialMode);
  }

  const hosts = useHostStore((s) => s.hosts);
  const projects = useProjectStore((s) => s.projects);
  const cloneProject = useProjectStore((s) => s.cloneProject);

  const hostOptions = useMemo(
    () => [{ value: LOCAL_HOST_ID, label: "This Mac" }, ...remoteHostOptions(hosts)],
    [hosts],
  );

  const [hostId, setHostId] = useState<string>(LOCAL_HOST_ID);
  const [repoUrl, setRepoUrl] = useState("");
  const [pickedRepo, setPickedRepo] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  // Location follows `<parent>/<repo name>` until the user types in it;
  // Browse… only swaps the parent, so it keeps following the repo.
  const [location, setLocation] = useState("");
  const [locationEdited, setLocationEdited] = useState(false);
  const [browsedParent, setBrowsedParent] = useState<string | null>(null);

  // `null` until `gh` answers; `[]` when it's missing, unauthed or empty.
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [reposRequested, setReposRequested] = useState(false);

  const isLocal = !isRemoteHost(hostId);
  const repoName = repoNameFromUrl(repoUrl);
  const effectiveName = nameEdited ? name : repoName;

  const defaultParent = useMemo(() => {
    const latest = [...projects].reverse().find((p) => p.hostId === hostId);
    return latest ? parentDir(latest.path) : DEFAULT_CLONE_PARENT;
  }, [projects, hostId]);
  const parent = (isLocal ? browsedParent : null) ?? defaultParent;
  const targetDir = locationEdited ? location : repoName ? joinPath(parent, repoName) : "";

  // Fetched once, the first time the clone form is shown; the main process
  // caches it for a few minutes on top of that.
  useEffect(() => {
    if (!open || mode !== "clone" || reposRequested) return;
    setReposRequested(true);
    window.electronAPI.github.listRepos().then(setRepos, () => setRepos([]));
  }, [open, mode, reposRequested]);

  const repoOptions = useMemo(
    () =>
      (repos ?? []).map((r) => ({
        value: r.nameWithOwner,
        label: r.private ? `${r.nameWithOwner} · private` : r.nameWithOwner,
      })),
    [repos],
  );

  const flow = useHostCloneFlow({
    hostId,
    skipHealthChecks: isLocal,
    run: () =>
      cloneProject({
        hostId,
        repoUrl: repoUrl.trim(),
        targetDir: targetDir.trim(),
        name: effectiveName.trim() || nameFromRepoUrl(repoUrl),
      }),
  });

  const reset = useCallback(() => {
    setMode(initialMode);
    setHostId(LOCAL_HOST_ID);
    setRepoUrl("");
    setPickedRepo("");
    setName("");
    setNameEdited(false);
    setLocation("");
    setLocationEdited(false);
    setBrowsedParent(null);
    flow.reset();
  }, [flow, initialMode]);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && flow.step !== "cloning") {
        onClose();
        reset();
      }
    },
    [onClose, reset, flow.step],
  );

  const handleAddLocal = useCallback(async () => {
    // The local flow opens a folder picker and then `ProjectSetupWizard` —
    // both would otherwise render underneath this Radix dialog while it
    // waits for `onAddLocal` to resolve. Close it first so the picker and
    // wizard are on top (ADR-178 ticket 5 review); an error surfaces as a
    // toast instead of inline, since the dialog is already gone.
    onClose();
    reset();
    setAddingLocal(true);
    try {
      await onAddLocal();
    } catch (err) {
      addErrorToast("add-local-project", "Failed to add project", err);
    } finally {
      setAddingLocal(false);
    }
  }, [onAddLocal, onClose, reset]);

  const handlePickRepo = useCallback(
    (nameWithOwner: string) => {
      const repo = repos?.find((r) => r.nameWithOwner === nameWithOwner);
      if (!repo) return;
      setPickedRepo(nameWithOwner);
      setRepoUrl(repo.cloneUrl);
    },
    [repos],
  );

  const handleBrowse = useCallback(async () => {
    const picked = await pickDirectory();
    if (!picked) return;
    setBrowsedParent(picked);
    // A typed location is replaced by the browsed one, which then follows
    // the repo name again.
    setLocationEdited(false);
  }, []);

  const canClone = !!hostId && !!repoUrl.trim() && !!targetDir.trim();

  const handleClone = useCallback(async () => {
    if (!canClone) return;
    const project = await flow.start();
    if (!project) return;
    if (isLocal) {
      // Like "Open folder": the setup wizard takes over, so get out of its way.
      onClose();
      reset();
      onLocalProjectCloned?.(project);
    } else {
      onRemoteProjectAdded?.(project);
    }
  }, [canClone, flow, isLocal, onClose, reset, onLocalProjectCloned, onRemoteProjectAdded]);

  const handleFixInTerminal = useCallback(
    (check: Parameters<typeof flow.fix>[0]) => {
      flow.fix(check);
      // The terminal tab renders behind this dialog otherwise (ADR-178
      // ticket 5 review) — close it so the user lands where the command was
      // typed.
      onClose();
      reset();
    },
    [flow, onClose, reset],
  );

  const handleDone = useCallback(() => {
    onClose();
    reset();
  }, [onClose, reset]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} data-testid="add-project-dialog">
          <Row align="center" justify="space-between" className={styles.header}>
            <Dialog.Title className={styles.title}>Add Project</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </Row>
          <Stack className={styles.body}>
            {flow.step === "form" && (
              <>
                {!webApp && (
                  <ToggleGroup
                    value={mode}
                    onChange={setMode}
                    size="sm"
                    aria-label="How to add the project"
                    options={[
                      { value: "folder", label: "Open folder" },
                      { value: "clone", label: "Clone repository" },
                    ]}
                  />
                )}
                {mode === "folder" ? (
                  <Stack gap="sm">
                    <div className={styles.fieldHint}>
                      Choose a folder on this machine.
                    </div>
                    <Row justify="flex-end">
                      <Button
                        variant="primary"
                        disabled={addingLocal}
                        onClick={handleAddLocal}
                      >
                        {addingLocal ? "Adding…" : "Choose Folder…"}
                      </Button>
                    </Row>
                  </Stack>
                ) : (
                  <Stack gap="sm">
                    <Stack>
                      <label className={styles.fieldLabel} htmlFor="add-project-host">
                        Host
                      </label>
                      <SearchableSelect
                        id="add-project-host"
                        value={hostId}
                        onChange={setHostId}
                        options={hostOptions}
                        maxWidth={440}
                        placeholder="Select a host…"
                      />
                    </Stack>
                    {(repos === null || repos.length > 0) && (
                      <Stack>
                        <label className={styles.fieldLabel} htmlFor="add-project-repo">
                          Repository
                        </label>
                        <SearchableSelect
                          id="add-project-repo"
                          value={pickedRepo}
                          onChange={handlePickRepo}
                          options={repoOptions}
                          loading={repos === null}
                          maxWidth={440}
                          placeholder="Search your GitHub repos…"
                        />
                      </Stack>
                    )}
                    <RepoUrlField
                      id="add-project-repo-url"
                      label={repos && repos.length > 0 ? "Or paste a URL" : "Repo URL"}
                      value={repoUrl}
                      onChange={(value) => {
                        setRepoUrl(value);
                        setPickedRepo("");
                      }}
                    />
                    <CloneDirField
                      id="add-project-location"
                      label="Location"
                      value={targetDir}
                      onChange={(value) => {
                        setLocation(value);
                        setLocationEdited(true);
                      }}
                      placeholder={joinPath(parent, "repo")}
                      action={
                        isLocal && !webApp ? (
                          <Button variant="secondary" onClick={handleBrowse}>
                            Browse…
                          </Button>
                        ) : undefined
                      }
                    />
                    <Stack>
                      <label className={styles.fieldLabel} htmlFor="add-project-name">
                        Name
                      </label>
                      <Input
                        id="add-project-name"
                        value={effectiveName}
                        onChange={(e) => {
                          setName(e.target.value);
                          setNameEdited(true);
                        }}
                        placeholder="Project name"
                      />
                    </Stack>
                    {!isLocal && (
                      <div className={styles.fieldHint}>
                        Log in on the box — Manor doesn't copy your keys.
                      </div>
                    )}
                    {flow.error && <div className={styles.error}>{flow.error}</div>}
                    <Row gap="sm" justify="flex-end">
                      <Button variant="secondary" onClick={handleDone}>
                        Cancel
                      </Button>
                      <Button variant="primary" disabled={!canClone} onClick={handleClone}>
                        Clone
                      </Button>
                    </Row>
                  </Stack>
                )}
              </>
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
