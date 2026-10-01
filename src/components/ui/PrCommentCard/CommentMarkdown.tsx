import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Link } from "../Link/Link";
import styles from "./PrCommentCard.module.css";

/**
 * GitHub-flavoured markdown, rendered to React nodes. Inline HTML — the
 * `<details>`, `<img>` and `<sub>` GitHub comments are full of — is parsed
 * too, then run through the GitHub-style sanitiser so scripts, handlers and
 * unknown tags never reach the DOM. Links open in the browser rather than
 * navigating the window; images are reduced to their alt text since the
 * popover cannot load remote content.
 */
export default function CommentMarkdown(props: { source: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={{
        a: ({ href, children }) =>
          href ? (
            <Link
              variant="inline"
              href={href}
              title={href}
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </Link>
          ) : (
            <span>{children}</span>
          ),
        img: ({ alt }) => <span className={styles.tag}>{alt || "image"}</span>,
      }}
    >
      {props.source}
    </Markdown>
  );
}
