import { GfmMarkdown } from "../GfmMarkdown/GfmMarkdown";
import styles from "./PrCommentCard.module.css";

type CommentMarkdownProps = {
  source: string;
};

/**
 * A PR comment as GitHub-flavoured markdown. Link clicks don't reach the
 * card underneath; images are reduced to their alt text since the popover
 * cannot load remote content.
 */
export default function CommentMarkdown(props: CommentMarkdownProps) {
  return (
    <GfmMarkdown
      source={props.source}
      onLinkClick={(e) => e.stopPropagation()}
      renderImage={({ alt }) => <span className={styles.tag}>{alt || "image"}</span>}
    />
  );
}
