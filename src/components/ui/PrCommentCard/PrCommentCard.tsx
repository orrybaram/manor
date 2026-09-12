import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import Bot from "lucide-react/dist/esm/icons/bot";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import FileCode from "lucide-react/dist/esm/icons/file-code";
import History from "lucide-react/dist/esm/icons/history";
import type { PrComment } from "../../../lib/pr-info";
import { relativeShortThenDate } from "../../../utils/relative-time";
import { Button } from "../Button/Button";
import { Link } from "../Link/Link";
import { Tooltip } from "../Tooltip/Tooltip";
import styles from "./PrCommentCard.module.css";

/**
 * One comment, as a card: who said it, then the file it hangs off and the
 * whole body, rendered as GitHub-flavoured markdown. Comments are what the PR
 * popover is for, so nothing is clipped — the one exception is a thread that
 * is finished with (resolved, or outdated because the code it points at is
 * gone), which collapses to its header until clicked.
 *
 * Shared so the notification comment preview shows a comment exactly as the
 * PR popover does.
 */
export function PrCommentCard(props: {
  comment: PrComment;
  onSendToAgent?: (comment: PrComment) => void;
}) {
  const { comment, onSendToAgent } = props;
  const [expanded, setExpanded] = useState(false);
  const body = comment.body.trim();

  const isThread = comment.kind === "thread";
  const resolved = isThread && comment.isResolved === true;
  const outdated = isThread && comment.isOutdated === true;
  const unresolved = isThread && !resolved && !outdated;
  const collapsible = resolved || outdated;
  const showBody = !collapsible || expanded;
  const canSendToAgent = unresolved && onSendToAgent !== undefined;

  const meta = (
    <>
      {collapsible && (
        <ChevronDown
          size={11}
          className={`${styles.chevron}${expanded ? ` ${styles.chevronOpen}` : ""}`}
        />
      )}
      <span className={styles.author}>
        {comment.author ? `@${comment.author}` : "unknown"}
      </span>
      <CommentTag comment={comment} outdated={outdated} />
      <CommentTime iso={comment.createdAt} />
    </>
  );

  return (
    <div
      className={`${styles.item}${unresolved ? ` ${styles.unresolved}` : ""}${collapsible && !expanded ? ` ${styles.done}` : ""}`}
    >
      <div
        className={`${styles.top}${canSendToAgent ? ` ${styles.topWide}` : ""}`}
      >
        {collapsible ? (
          <Button
            variant="ghost"
            size="sm"
            className={styles.toggle}
            title={expanded ? "Collapse this comment" : "Expand this comment"}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {meta}
          </Button>
        ) : (
          <div className={styles.meta}>{meta}</div>
        )}
      </div>

      {showBody && (
        <div className={styles.content}>
          {isThread && comment.path && <CommentFile path={comment.path} />}
          {body ? (
            <div className={styles.body}>
              <CommentMarkdown source={body} />
            </div>
          ) : (
            <div className={styles.empty}>No comment text.</div>
          )}
        </div>
      )}

      <span className={styles.actions}>
        {canSendToAgent && (
          <Button
            variant="ghost"
            size="sm"
            className={styles.action}
            title="Send this comment to a new agent in this workspace"
            aria-label="Send this comment to an agent"
            onClick={(e) => {
              e.stopPropagation();
              onSendToAgent(comment);
            }}
          >
            <Bot size={11} />
          </Button>
        )}
        <Link
          variant="plain"
          href={comment.url}
          className={styles.action}
          title="Open this comment on GitHub"
          aria-label="Open this comment on GitHub"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={11} />
        </Link>
      </span>
    </div>
  );
}

/**
 * The file a review thread hangs off, sitting with the comment text rather
 * than in the header — so a collapsed thread folds the path away too. The
 * directory is what gets dropped when the path is too long: the filename is
 * the part worth reading, and the full path is on hover.
 */
function CommentFile(props: { path: string }) {
  const slash = props.path.lastIndexOf("/");
  const dir = slash === -1 ? "" : props.path.slice(0, slash + 1);
  const name = slash === -1 ? props.path : props.path.slice(slash + 1);

  return (
    <div className={styles.file} title={props.path}>
      <FileCode size={10} className={styles.fileIcon} />
      {dir && <span className={styles.fileDir}>{dir}</span>}
      <span className={styles.fileName}>{name}</span>
    </div>
  );
}

/** "2d ago" in the row; the full local date and time on hover. */
function CommentTime(props: { iso: string }) {
  const ms = Date.parse(props.iso);
  const exact = new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <Tooltip label={exact} side="top">
      <span className={styles.time}>{relativeShortThenDate(ms)}</span>
    </Tooltip>
  );
}

/**
 * GitHub-flavoured markdown, rendered to React nodes. Inline HTML — the
 * `<details>`, `<img>` and `<sub>` GitHub comments are full of — is parsed
 * too, then run through the GitHub-style sanitiser so scripts, handlers and
 * unknown tags never reach the DOM. Links open in the browser rather than
 * navigating the window; images are reduced to their alt text since the
 * popover cannot load remote content.
 */
function CommentMarkdown(props: { source: string }) {
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

/** What kind of remark this is: a verdict, a thread's state, or nothing. */
function CommentTag(props: { comment: PrComment; outdated?: boolean }) {
  const { comment, outdated } = props;

  if (comment.kind === "review") {
    if (comment.reviewState === "APPROVED") {
      return (
        <span className={`${styles.tag} ${styles.toneGood}`}>approved</span>
      );
    }
    if (comment.reviewState === "CHANGES_REQUESTED") {
      return (
        <span className={`${styles.tag} ${styles.toneWarn}`}>
          changes requested
        </span>
      );
    }
    return <span className={styles.tag}>review</span>;
  }

  if (comment.kind === "thread") {
    if (outdated) {
      return (
        <span className={styles.tag}>
          <History size={9} />
          outdated
        </span>
      );
    }
    if (comment.isResolved === true) {
      return <span className={styles.tag}>resolved</span>;
    }
    return (
      <span className={`${styles.tag} ${styles.toneWarn}`}>unresolved</span>
    );
  }

  return null;
}
