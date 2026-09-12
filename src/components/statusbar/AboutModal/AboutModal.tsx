import * as Dialog from "@radix-ui/react-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ManorLogo } from "../../ui/ManorLogo";
import { Link } from "../../ui/Link/Link";
import changelogSource from "../../../../CHANGELOG.md?raw";
import styles from "./AboutModal.module.css";

/**
 * The changelog ships with the build, so what the modal shows always matches
 * the version running. Its own "# Changelog" title is dropped — the section
 * heading above the scroller already says as much.
 */
const CHANGELOG = changelogSource.replace(/^#\s+Changelog\s*\n/, "").trim();

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
          <div className={styles.changelogLabel}>Changelog</div>
          <div className={styles.changelog}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) =>
                  href ? (
                    <Link
                      href={href}
                      title={href}
                    >
                      {children}
                    </Link>
                  ) : (
                    <span>{children}</span>
                  ),
              }}
            >
              {CHANGELOG}
            </Markdown>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
