import * as ContextMenu from "@radix-ui/react-context-menu";
import { createContext, useContext, type ReactNode, type RefObject } from "react";
import { Link } from "../../ui/Link/Link";
import { LinkMenuItems } from "../../workspace-panes/LinkMenuItems";
import paneStyles from "../../workspace-panes/TerminalPane/TerminalPane.module.css";

type ChatLinkMenu = {
  paneId: string;
  containerRef: RefObject<HTMLElement | null>;
};

/**
 * The pane a chat's links belong to, where they offer the link menu. Left
 * unset by the web app, which has no browser panes, and outside a pane (the
 * Agents modal's preview), so those keep the plain link.
 */
export const ChatLinkMenuContext = createContext<ChatLinkMenu | null>(null);

type ChatLinkProps = {
  href?: string;
  children?: ReactNode;
};

/**
 * A link in a chat's prose. Hoisted so `react-markdown` keeps its identity:
 * a component made per render would remount with each typed word and close
 * an open menu.
 */
export function ChatLink({ href, children }: ChatLinkProps) {
  const menu = useContext(ChatLinkMenuContext);
  if (!href) return <span>{children}</span>;

  const link = (
    <Link variant="inline" href={href} title={href}>
      {children}
    </Link>
  );
  // A browser pane and the default browser take http(s), as a terminal's URL links are.
  if (!menu || !/^https?:\/\//i.test(href)) return link;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{link}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={paneStyles.contextMenu}>
          <LinkMenuItems
            url={href}
            paneId={menu.paneId}
            containerRef={menu.containerRef}
            openClickHint="Click"
          />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
