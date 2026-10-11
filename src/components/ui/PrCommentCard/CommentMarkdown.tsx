import { GfmMarkdown } from "../GfmMarkdown/GfmMarkdown";
import styles from "./PrCommentCard.module.css";

type CommentMarkdownProps = {
  source: string;
};

/**
 * A PR comment as GitHub-flavoured markdown. Images are reduced to their
 * alt text since the popover cannot load remote content.
 */
export default function CommentMarkdown(props: CommentMarkdownProps) {
  return (
    <GfmMarkdown
      source={props.source}
      renderImage={({ alt }) => <span className={styles.tag}>{alt || "image"}</span>}
    />
  );
}
