import { useState } from "react";
import type { HostProfile } from "../../../electron.d";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { useHostProfileStore } from "../../../store/host-profile-store";
import { useHostStore } from "../../../store/host-store";
import { isHostRunning } from "../../../lib/host-groups";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import { Row, Stack } from "../../ui/Layout/Layout";
import { Switch } from "../../ui/Switch/Switch";
import { ToggleGroup } from "../../ui/ToggleGroup/ToggleGroup";
import { SettingField } from "../SettingRow";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";
import {
  restartedPodsText,
  restartPodsLabel,
  signInStatusText,
  signInWarningText,
} from "./host-settings-text";

type Which = "github" | "claude";
type GithubSource = "gh" | "pasted";

const GITHUB_SOURCES = [
  { value: "gh", label: "Use this computer's GitHub sign-in" },
  { value: "pasted", label: "Paste a token" },
];

/**
 * "Sign new pods in for me" (ADR-235 D9): the opt-in section of a Kubernetes
 * profile's editor. Tokens go straight to the cluster through main; they live
 * only in an input's local state until set, then the input is cleared.
 * Needs a saved profile.
 */
export function ProfileSignIn(props: { profile: HostProfile }) {
  // The profile as the store has it now: a change from another window, or
  // this one's own, shows here without reopening.
  const profile =
    useHostProfileStore((s) => s.profiles.find((p) => p.id === props.profile.id)) ??
    props.profile;
  const store = useHostProfileStore.getState();
  const runningPods = useHostStore(
    (s) => s.hosts.filter((h) => h.profileId === profile.id && isHostRunning(h)).length,
  );

  const signIn = profile.signIn ?? {};
  const [switchedOn, setOn] = useState(false);
  // Which token's controls are open although it is already set (Replace).
  const [replacing, setReplacing] = useState<Record<Which, boolean>>({
    github: false,
    claude: false,
  });
  const [source, setSource] = useState<GithubSource>("gh");
  const [githubToken, setGithubToken] = useState("");
  const [claudeToken, setClaudeToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a token changed, until the pods are restarted.
  const [changed, setChanged] = useState(false);
  const [restarted, setRestarted] = useState<string | null>(null);

  const work = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const afterChange = () => {
    setChanged(true);
    setRestarted(null);
  };

  const setGithub = () =>
    work(async () => {
      await store.setSignIn(profile.id, {
        github:
          source === "gh" ? { source: "gh" } : { source: "pasted", token: githubToken.trim() },
      });
      setGithubToken("");
      setReplacing((r) => ({ ...r, github: false }));
      afterChange();
    });

  const setClaude = () =>
    work(async () => {
      await store.setSignIn(profile.id, { claude: { token: claudeToken.trim() } });
      setClaudeToken("");
      setReplacing((r) => ({ ...r, claude: false }));
      afterChange();
    });

  const remove = (which: Which) =>
    work(async () => {
      await store.removeSignIn(profile.id, which);
      afterChange();
    });

  const restart = () =>
    work(async () => {
      const pods = await store.restartPods(profile.id);
      setChanged(false);
      setRestarted(restartedPodsText(pods.length));
    });

  const anySet = Boolean(signIn.github || signIn.claude);
  // Removing the last token leaves the section open until switched off.
  const on = switchedOn || anySet;
  const githubOpen = !signIn.github || replacing.github;
  const claudeOpen = !signIn.claude || replacing.claude;

  const status = (which: Which) => {
    const meta = signIn[which];
    if (!meta) return null;
    return (
      <Row gap="xs" align="center" data-testid={`signin-${which}-status`}>
        <span className={settingsStyles.fieldHint}>{signInStatusText(meta)}</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid={`signin-${which}-replace`}
          onClick={() => setReplacing((r) => ({ ...r, [which]: !r[which] }))}
        >
          Replace
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid={`signin-${which}-remove`}
          onClick={() => void remove(which)}
        >
          Remove
        </Button>
      </Row>
    );
  };

  return (
    <Stack gap="sm" data-testid="profile-signin">
      <SettingField
        label="Sign new pods in for me"
        hint={
          anySet
            ? "Remove both tokens to turn this off."
            : "Off: each pod needs its own gh and claude sign-in."
        }
      >
        <Switch
          checked={on}
          disabled={busy || anySet}
          onCheckedChange={setOn}
          aria-label="Sign new pods in for me"
          data-testid="signin-toggle"
        />
      </SettingField>
      {on && (
        <>
          <div className={styles.startHint} data-testid="signin-warning">
            {signInWarningText(profile.values.namespace ?? "")}
          </div>

          <SettingField label="GitHub" hint="For clone and git push.">
            <Stack gap="xs">
              {status("github")}
              {githubOpen && (
                <>
                  <ToggleGroup
                    value={source}
                    onChange={(v) => setSource(v as GithubSource)}
                    options={GITHUB_SOURCES}
                    size="sm"
                    aria-label="GitHub token source"
                    data-testid="signin-github-source"
                  />
                  {source === "pasted" && (
                    <Input
                      type="password"
                      autoComplete="off"
                      placeholder="A fine-grained token, limited to the repositories you need"
                      value={githubToken}
                      disabled={busy}
                      data-testid="signin-github-token"
                      onChange={(e) => setGithubToken(e.target.value)}
                    />
                  )}
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid="signin-github-set"
                      disabled={busy || (source === "pasted" && githubToken.trim() === "")}
                      onClick={() => void setGithub()}
                    >
                      {signIn.github ? "Replace token" : "Set token"}
                    </Button>
                  </div>
                </>
              )}
            </Stack>
          </SettingField>

          <SettingField
            label="Claude"
            hint={
              <>
                Paste the output of <code>claude setup-token</code>.
              </>
            }
          >
            <Stack gap="xs">
              {status("claude")}
              {claudeOpen && (
                <>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Token from claude setup-token"
                    value={claudeToken}
                    disabled={busy}
                    data-testid="signin-claude-token"
                    onChange={(e) => setClaudeToken(e.target.value)}
                  />
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid="signin-claude-set"
                      disabled={busy || claudeToken.trim() === ""}
                      onClick={() => void setClaude()}
                    >
                      {signIn.claude ? "Replace token" : "Set token"}
                    </Button>
                  </div>
                </>
              )}
            </Stack>
          </SettingField>
        </>
      )}
      {(changed || restarted) && (
        <Row gap="xs" align="center" data-testid="signin-restart">
          {changed ? (
            <>
              <span className={settingsStyles.fieldHint}>Restart running pods to use it.</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                data-testid="signin-restart-button"
                onClick={() => void restart()}
              >
                {restartPodsLabel(runningPods)}
              </Button>
            </>
          ) : (
            <span className={settingsStyles.fieldHint}>{restarted}</span>
          )}
        </Row>
      )}
      {error && (
        <div className={settingsStyles.linearError} data-testid="signin-error">
          {error}
        </div>
      )}
    </Stack>
  );
}
