import * as Dialog from "@radix-ui/react-dialog";
import { ManorLogo } from "./ui/ManorLogo";
import styles from "./AboutModal.module.css";

const INSPIRATIONS = [
  { name: "superset", url: "https://github.com/superset-sh/superset" },
  { name: "supacode", url: "https://github.com/supabitapp/supacode" },
  { name: "react-grab", url: "https://github.com/aidenybai/react-grab" },
  { name: "libghostty", url: "https://github.com/ghostty-org/ghostty" },
  { name: "xterm", url: "https://github.com/xtermjs/xterm.js" },
  { name: "t3code", url: "https://github.com/pingdotgg/t3code" },
  { name: "agent-deck", url: "https://github.com/asheshgoplani/agent-deck" },
];

type AboutModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AboutModal(props: AboutModalProps) {
  const { open, onOpenChange } = props;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.title}>Manor</Dialog.Title>
          <div className={styles.logo}>
            <ManorLogo />
          </div>
          <div className={styles.version}>v{__APP_VERSION__}</div>
          <div className={styles.divider} />
          <div className={styles.inspiredLabel}>Inspired by</div>
          <div className={styles.links}>
            {INSPIRATIONS.map((item) => (
              <button
                key={item.name}
                className={styles.link}
                onClick={() =>
                  window.electronAPI.shell.openExternal(item.url)
                }
              >
                {item.name}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
