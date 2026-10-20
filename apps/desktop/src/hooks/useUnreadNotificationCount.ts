import { useNotificationStore } from "../store/notification-store";

/** How many notifications are unread. */
export function useUnreadNotificationCount(): number {
  return useNotificationStore((s) => s.unreadCount);
}
