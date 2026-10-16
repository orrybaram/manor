import { useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import Copy from "lucide-react/dist/esm/icons/copy";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { Stack } from "../../ui/Layout/Layout";
import styles from "./HostsPage.module.css";

const COPIED_MS = 1600;

type CopyCommandProps = {
  /** What the command is for, for the button's label. */
  label: string;
  command: string;
};

/** A command to run in a terminal, with a button that copies it. */
function CopyCommand(props: CopyCommandProps) {
  const { label, command } = props;

  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className={styles.guideCommand}>
      <code>{command}</code>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Copy the ${label} command`}
        onClick={copy}
      >
        {copied ? (
          <Check size={11} aria-hidden />
        ) : (
          <Copy size={11} aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * "Where's your cluster?" (ADR-234 D13): what the Kubernetes Connect step
 * shows while kubectl knows of no cluster. Three places one can come from,
 * each with the one step that makes kubectl know it. The form leaves these
 * for the normal fields as soon as a cluster appears.
 */
export function ClusterGuide() {
  return (
    <Stack gap="sm" data-testid="cluster-guide">
      <div className={styles.pathTitle}>Where&apos;s your cluster?</div>
      <div className={styles.pathDescription}>
        kubectl doesn&apos;t know of a cluster yet. Pick the closest match; this
        page notices on its own once there is one.
      </div>

      <div className={styles.guideCard} data-testid="cluster-guide-have">
        <span className={styles.pathTitle}>I already have a cluster</span>
        <span className={styles.pathDescription}>
          Its connection details live in a kubeconfig file. Put that file at{" "}
          <code>~/.kube/config</code> (or point the <code>KUBECONFIG</code>{" "}
          variable at it before starting Manor).
        </span>
      </div>

      <div className={styles.guideCard} data-testid="cluster-guide-cloud">
        <span className={styles.pathTitle}>A cluster in the cloud</span>
        <span className={styles.pathDescription}>
          Create one, then run its sign-in command in a terminal. It saves the
          cluster into your kubeconfig.
        </span>
        <span className={styles.pathDescription}>
          Google:{" "}
          <Link href="https://cloud.google.com/kubernetes-engine/docs/how-to/creating-an-autopilot-cluster">
            create a GKE Autopilot cluster
          </Link>
        </span>
        <CopyCommand
          label="Google sign-in"
          command="gcloud container clusters get-credentials <name> --region <region>"
        />
        <span className={styles.pathDescription}>
          DigitalOcean:{" "}
          <Link href="https://docs.digitalocean.com/products/kubernetes/how-to/create-clusters/">
            create a Kubernetes cluster
          </Link>
        </span>
        <CopyCommand
          label="DigitalOcean sign-in"
          command="doctl kubernetes cluster kubeconfig save <name>"
        />
      </div>

      <div className={styles.guideCard} data-testid="cluster-guide-practice">
        <span className={styles.pathTitle}>
          A practice cluster on this computer
        </span>
        <span className={styles.pathDescription}>
          Docker Desktop: Settings, then Kubernetes, then Enable. OrbStack:
          Settings, then Kubernetes, then Enable. For a host on this computer,
          the Docker container template is simpler.
        </span>
      </div>
    </Stack>
  );
}
