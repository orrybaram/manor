import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { TaskProvider } from "../../../lib/tasks";
import { Link } from "../../ui/Link/Link";
import { ProxiedImage } from "./ProxiedImage";

type TaskMarkdownProps = {
  provider: TaskProvider;
  source: string;
};

/**
 * A task body as GitHub-flavoured markdown. Inline HTML (`<img>`,
 * `<details>`) is parsed then sanitised, as in `CommentMarkdown`; links open
 * in the browser, and images load through the tracker's auth'd proxy so a
 * private repo's screenshots render in place.
 */
export default function TaskMarkdown(props: TaskMarkdownProps) {
  const { provider, source } = props;

  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={{
        a: ({ href, children }) =>
          href ? (
            <Link variant="inline" href={href} title={href}>
              {children}
            </Link>
          ) : (
            <span>{children}</span>
          ),
        img: ({ src, alt }) =>
          typeof src === "string" && src ? (
            <ProxiedImage key={src} provider={provider} url={src} alt={alt} />
          ) : null,
      }}
    >
      {source}
    </Markdown>
  );
}
