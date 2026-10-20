import type { ReactNode } from "react";
import Markdown from "react-markdown";
import { httpUrl } from "../../../lib/http-url";
import { Button } from "../Button/Button";
import { Link } from "../Link/Link";
import { gfmPipeline } from "./gfm-pipeline";
import styles from "./GfmMarkdown.module.css";

/** An image in the source, its `src` already resolved against `baseUrl`. */
export type GfmImage = {
  src: string;
  alt?: string;
  width?: string;
  height?: string;
};

type GfmMarkdownProps = {
  source: string;
  /** Where the source lives, so relative links (`../blob/main/SPEC.md`) resolve. */
  baseUrl?: string;
  /** How to render an image. */
  renderImage: (image: GfmImage) => ReactNode;
};

/**
 * GitHub-flavoured markdown, rendered to React nodes. Inline HTML — the
 * `<details>`, `<img>` and `<sub>` GitHub bodies are full of — is parsed
 * too, then run through the GitHub-style sanitiser so scripts, handlers and
 * unknown tags never reach the DOM.
 *
 * http(s) links open in the browser, relative ones first resolved against
 * `baseUrl`; `#` links (footnotes) scroll within this block; anything else is
 * plain text, since the window-open handler ignores it. Link clicks never
 * reach an enclosing clickable (a card, a row).
 */
export function GfmMarkdown(props: GfmMarkdownProps) {
  const { source, baseUrl, renderImage } = props;

  return (
    <Markdown
      {...gfmPipeline}
      components={{
        a: ({ href, children }) => {
          if (href?.startsWith("#") && href.length > 1) {
            return (
              <Button
                variant="link"
                className={styles.anchor}
                onClick={(e) => {
                  e.stopPropagation();
                  jumpTo(e.currentTarget, href);
                }}
              >
                {children}
              </Button>
            );
          }
          const url = href ? httpUrl(href, baseUrl) : null;
          return url ? (
            <Link variant="inline" href={url} title={url}
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </Link>
          ) : (
            <span>{children}</span>
          );
        },
        img: ({ src, alt, width, height }) => {
          if (typeof src !== "string" || !src) return null;
          const url = httpUrl(src, baseUrl);
          if (!url) return null;
          return renderImage({
            src: url,
            alt,
            width: width === undefined ? undefined : String(width),
            height: height === undefined ? undefined : String(height),
          });
        },
      }}
    >
      {source}
    </Markdown>
  );
}

/**
 * Scroll to the element `hash` names, nearest to `from` first so two bodies
 * on screen with the same footnote ids each jump within themselves. `hash`
 * is an unprefixed href (see `gfmPipeline`); the target carries the
 * sanitiser's `user-content-` prefix.
 */
function jumpTo(from: HTMLElement, hash: string) {
  const id = decodeURIComponent(hash.slice(1));
  const selector = `[id="${CSS.escape(`user-content-${id}`)}"]`;
  for (let node = from.parentElement; node; node = node.parentElement) {
    const target = node.querySelector(selector);
    if (target) {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
  }
}
