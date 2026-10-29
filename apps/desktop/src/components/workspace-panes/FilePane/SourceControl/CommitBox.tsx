import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import CloudUpload from "lucide-react/dist/esm/icons/cloud-upload";
import { getPlatform } from "../../../../lib/keybindings";
import { Button } from "../../../ui/Button/Button";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import {
  COMMIT_OPTIONS,
  commitBlocker,
  runCommit,
  type CommitFlag,
} from "./commit";
import { startPush, usePushing } from "./push";
import styles from "./CommitBox.module.css";

/**
 * Each workspace's unsent message, by workspace key: the drawer closing or
 * the pane remounting keeps what was typed. In memory only.
 */
const messages = new Map<string, string>();

type CommitBoxProps = {
  /** Keys the message, so two workspaces' drafts stay apart. */
  wsKey: string;
  workspacePath: string;
  stagedCount: number;
  /** Why git can't be reached from here (the web app), or null. */
  disabledReason: string | null;
  /** A stage, unstage or discard is running: git holds the index. */
  busy: boolean;
  /** Tells the list a commit holds the index, so its git buttons wait. */
  onCommittingChange: (committing: boolean) => void;
};

/**
 * The top of Source Control's Local view: a message, Commit (⌘↵) for what's
 * staged, and in its menu Commit & Push, Push, and the commit options.
 */
export function CommitBox({
  wsKey,
  workspacePath,
  stagedCount,
  disabledReason,
  busy,
  onCommittingChange,
}: CommitBoxProps) {
  const [message, setMessageState] = useState(() => messages.get(wsKey) ?? "");
  const [flags, setFlags] = useState<ReadonlySet<CommitFlag>>(() => new Set());
  const [committing, setCommitting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pushing = usePushing(workspacePath);

  const setMessage = (next: string) => {
    if (next) messages.set(wsKey, next);
    else messages.delete(wsKey);
    setMessageState(next);
  };

  const blocker = disabledReason ?? commitBlocker(message, stagedCount, flags);
  const off = disabledReason !== null;
  const amend = flags.has("--amend");

  const commit = async (thenPush: boolean) => {
    setMenuOpen(false);
    if (blocker || committing || busy) return;
    setCommitting(true);
    onCommittingChange(true);
    const sent = message;
    const ok = await runCommit(workspacePath, sent, flags);
    setCommitting(false);
    onCommittingChange(false);
    if (!ok) return;
    // Text typed while the commit ran is the next message: keep it.
    if ((messages.get(wsKey) ?? "") === sent) setMessage("");
    setFlags(new Set());
    if (thenPush) void startPush(workspacePath);
  };

  const toggleFlag = (flag: CommitFlag) =>
    setFlags((prev) => {
      const next = new Set(prev);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return next;
    });

  const mod = getPlatform() === "mac" ? "⌘" : "Ctrl+";
  const label = committing ? "Committing…" : amend ? "Amend" : "Commit";

  const commitButton = (
    <Button
      variant="primary"
      size="sm"
      className={styles.commit}
      // aria-disabled keeps the reason's tooltip reachable on hover.
      aria-disabled={blocker || committing || busy ? true : undefined}
      data-testid="scm-commit"
      onClick={() => void commit(false)}
    >
      {committing ? <span className={styles.spinner} /> : <Check size={13} />}
      {label}
    </Button>
  );

  const messageInput = (
    <textarea
      className={styles.message}
      placeholder={
        amend
          ? `Message (empty keeps the last one, ${mod}↵ to amend)`
          : `Message (${mod}↵ to commit)`
      }
      aria-label="Commit message"
      rows={1}
      value={message}
      // Read-only rather than disabled, so its tooltip still shows on hover.
      readOnly={off}
      aria-disabled={off || undefined}
      data-testid="scm-commit-message"
      onChange={(e) => setMessage(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void commit(false);
        }
      }}
    />
  );

  return (
    <div className={styles.box} data-testid="scm-commit-box">
      {disabledReason ? (
        <Tooltip label={disabledReason}>{messageInput}</Tooltip>
      ) : (
        messageInput
      )}
      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <div className={styles.split}>
          {blocker ? (
            <Tooltip label={blocker}>{commitButton}</Tooltip>
          ) : (
            commitButton
          )}
          <Tooltip label={disabledReason ?? "Push and commit options"}>
            <Popover.Trigger asChild>
              <Button
                variant="primary"
                size="sm"
                className={styles.caret}
                aria-label="More commit actions"
                aria-disabled={off || undefined}
                data-testid="scm-commit-menu"
                // A prevented click doesn't open the menu.
                onClick={(e) => {
                  if (off) e.preventDefault();
                }}
              >
                <ChevronDown size={13} />
              </Button>
            </Popover.Trigger>
          </Tooltip>
        </div>
        <Popover.Portal>
          <Popover.Content
            className={styles.menu}
            align="end"
            sideOffset={4}
            collisionPadding={8}
            // Escape closes only the menu: React bubbles it, through the
            // portal, to the drawer, which would close on it too.
            onKeyDown={(e) => {
              if (e.key === "Escape") e.stopPropagation();
            }}
          >
            <MenuItem
              testId="scm-commit-push"
              disabled={blocker !== null || committing || pushing}
              onSelect={() => void commit(true)}
            >
              <Check size={12} />
              {amend ? "Amend & Push" : "Commit & Push"}
            </MenuItem>
            <MenuItem
              testId="scm-push"
              disabled={pushing}
              onSelect={() => {
                setMenuOpen(false);
                void startPush(workspacePath);
              }}
            >
              <CloudUpload size={12} />
              {pushing ? "Pushing…" : "Push"}
            </MenuItem>
            <div className={styles.separator} />
            {COMMIT_OPTIONS.map(({ flag, label }) => (
              <MenuItem
                key={flag}
                testId={`scm-commit-flag-${flag.slice(2)}`}
                checked={flags.has(flag)}
                onSelect={() => toggleFlag(flag)}
              >
                <span className={styles.checkSlot}>
                  {flags.has(flag) && <Check size={12} />}
                </span>
                {label}
              </MenuItem>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function MenuItem({
  children,
  testId,
  disabled,
  checked,
  onSelect,
}: {
  children: ReactNode;
  testId: string;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.item}
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
    >
      {children}
    </Button>
  );
}
