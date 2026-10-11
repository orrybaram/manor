import { useUnreadNotificationCount } from "../../hooks/useUnreadNotificationCount";
import { CountBadge } from "../ui/CountBadge/CountBadge";

type UnreadBadgeProps = {
  /** `dot` for an icon-only nav button, `count` beside a labelled row. */
  variant: "dot" | "count";
  className?: string;
};

/** The Notifications nav entry's unread marker; nothing while all is read. */
export function UnreadBadge(props: UnreadBadgeProps) {
  const { variant, className } = props;

  const unreadCount = useUnreadNotificationCount();

  if (unreadCount === 0) return null;
  if (variant === "dot") {
    return <span className={className} data-testid="notifications-row-badge" />;
  }
  return (
    <CountBadge
      count={unreadCount}
      className={className}
      data-testid="notifications-row-badge"
      aria-label={`${unreadCount} unread`}
    />
  );
}
