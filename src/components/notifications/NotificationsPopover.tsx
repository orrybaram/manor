import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import Bell from "lucide-react/dist/esm/icons/bell";
import Bot from "lucide-react/dist/esm/icons/bot";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check";
import CircleX from "lucide-react/dist/esm/icons/circle-x";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import type { NotificationKind, NotificationRecord } from "../../electron.d";
import { useNotificationStore } from "../../store/notification-store";
import { navigateToNotification } from "../../utils/notification-navigation";
import {
  BUCKET_ORDER,
  getDateBucket,
  type DateBucket,
} from "../../utils/date-buckets";
import { relativeShortThenDate } from "../../utils/relative-time";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import styles from "./NotificationsPopover.module.css";

const ICON_FOR: Record<NotificationKind, typeof Bell> = {
  "agent-responded": Bot,
  "agent-requires-input": CircleHelp,
  "pr-comment": MessageSquare,
  "pr-approved": CircleCheck,
  "pr-changes-requested": CircleX,
  "pr-checks-failed": CircleX,
};

const TONE_FOR: Partial<Record<NotificationKind, string>> = {
  "agent-requires-input": styles.iconAttention,
  "pr-approved": styles.iconSuccess,
  "pr-changes-requested": styles.iconError,
  "pr-checks-failed": styles.iconError,
};

/**
 * The notification history (ADR-162 §6). Click-triggered rather than
 * hover-triggered like `PrPopover`: this is something you deliberately open,
 * not a badge you brush past.
 */
export function NotificationsPopover() {
  const [open, setOpen] = useState(false);
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clear = useNotificationStore((s) => s.clear);

  const grouped = new Map<DateBucket, NotificationRecord[]>();
  for (const record of notifications) {
    const bucket = getDateBucket(record.timestamp);
    const list = grouped.get(bucket);
    if (list) list.push(record);
    else grouped.set(bucket, [record]);
  }

  const handleRowClick = (record: NotificationRecord) => {
    setOpen(false);
    void navigateToNotification(record);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label="Notifications">
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={styles.bellButton}
            aria-label="Notifications"
          >
            <Bell size={12} />
            {unreadCount > 0 && (
              <span className={styles.badge}>
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side="bottom"
          align="end"
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className={styles.header}>
            <span className={styles.headerTitle}>Notifications</span>
            <Button
              variant="link"
              className={styles.headerAction}
              disabled={unreadCount === 0}
              onClick={() => void markAllRead()}
            >
              Mark all read
            </Button>
            <Button
              variant="link"
              className={styles.headerAction}
              disabled={notifications.length === 0}
              onClick={() => void clear()}
            >
              Clear
            </Button>
          </div>

          <div className={styles.scrollArea}>
            {notifications.length === 0 && (
              <div className={styles.empty}>Nothing here yet.</div>
            )}

            {BUCKET_ORDER.map((bucket) => {
              const records = grouped.get(bucket);
              if (!records) return null;

              return (
                <div key={bucket} className={styles.dateGroup}>
                  <div className={styles.dateGroupHeader}>{bucket}</div>
                  {records.map((record) => {
                    const Icon = ICON_FOR[record.kind] ?? Bell;
                    const tone = TONE_FOR[record.kind];
                    return (
                      <div
                        key={record.id}
                        className={`${styles.row} ${record.read ? styles.rowRead : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleRowClick(record)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleRowClick(record);
                          }
                        }}
                      >
                        <Icon
                          size={13}
                          className={`${styles.rowIcon} ${tone ?? ""}`}
                        />
                        <div className={styles.rowText}>
                          <div className={styles.rowTitle}>{record.title}</div>
                          <div className={styles.rowBody}>{record.body}</div>
                        </div>
                        <span className={styles.rowTime}>
                          {relativeShortThenDate(Date.parse(record.timestamp))}
                        </span>
                        {!record.read && <span className={styles.unreadDot} />}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
