import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "../../ui/Link/Link";
import styles from "./ChatPane.module.css";

/** The slice of a hast node this file touches. */
type HastNode = {
  type: string;
  value?: string;
  children?: HastNode[];
};

/**
 * Wraps each word of the rendered text in its own span. Spans keep their
 * place as the text grows, so only the words just added mount, and fade in.
 */
function rehypeFadeWords() {
  const wrap = (node: HastNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value?.trim()) {
        return child.value.split(/(?<=\s)(?=\S)/).map((word) => ({
          type: "element",
          tagName: "span",
          properties: { className: [styles.typedWord] },
          children: [{ type: "text", value: word }],
        }));
      }
      wrap(child);
      return [child];
    });
  };
  return wrap;
}

type ChatMarkdownProps = {
  source: string;
  /** Fade in words as they appear (while `ChatTypewriter` types). */
  fadeWords?: boolean;
  /**
   * Show an image as its alt text and address instead of loading it, so
   * merely looking at a transcript sends no request to a URL it names.
   */
  imagesAsText?: boolean;
};

/**
 * Claude's prose as GitHub-flavoured markdown. Raw HTML is not parsed (the
 * default), so the transcript can't put elements in the page, and links open
 * in the browser through `<Link>` rather than navigating the app.
 *
 * Memoized on its source: parsing is most of what a long chat costs, and a
 * push must not re-parse every reply above it.
 */
export const ChatMarkdown = memo(function ChatMarkdown(props: ChatMarkdownProps) {
  const { source, fadeWords = false, imagesAsText = false } = props;

  return (
    <div className={styles.markdown}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={fadeWords ? [rehypeFadeWords] : []}
        components={{
          a: ({ href, children }) =>
            href ? (
              <Link variant="inline" href={href} title={href}>
                {children}
              </Link>
            ) : (
              <span>{children}</span>
            ),
          ...(imagesAsText && {
            img: ({ src, alt }) => (
              <span className={styles.imageText}>
                [{alt || "image"}]{typeof src === "string" && src ? ` ${src}` : ""}
              </span>
            ),
          }),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
});
