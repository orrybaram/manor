import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "../../ui/Link/Link";
import styles from "./ChatPane.module.css";

type ChatMarkdownProps = {
  source: string;
};

/**
 * Claude's prose as GitHub-flavoured markdown. Raw HTML is not parsed (the
 * default), so the transcript can't put elements in the page, and links open
 * in the browser through `<Link>` rather than navigating the app.
 */
export function ChatMarkdown(props: ChatMarkdownProps) {
  const { source } = props;

  return (
    <div className={styles.markdown}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href ? (
              <Link variant="inline" href={href} title={href}>
                {children}
              </Link>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
