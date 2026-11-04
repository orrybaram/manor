import type { ReactNode } from "react";
import { Link } from "../../ui/Link/Link";

type ChatLinkProps = {
  href?: string;
  children?: ReactNode;
};

/**
 * A link in a chat's prose. Its right-click is the chat's (`ChatPaneMenu`).
 * Hoisted so `react-markdown` keeps its identity: a component made per render
 * would remount with each typed word.
 */
export function ChatLink({ href, children }: ChatLinkProps) {
  if (!href) return <span>{children}</span>;
  return (
    <Link variant="inline" href={href} title={href}>
      {children}
    </Link>
  );
}
