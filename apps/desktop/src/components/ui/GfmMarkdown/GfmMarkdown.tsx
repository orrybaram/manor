import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
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
  /**
   * A link no URL can be made of (`./other.md`): what clicking it does, or
   * null when it goes nowhere. Without this, such a link is plain text.
   */
  localLink?: (href: string) => (() => void) | null;
  /** An image no URL can be made of. Without this, it is left out. */
  renderLocalImage?: (image: GfmImage) => ReactNode;
};

/**
 * GitHub-flavoured markdown, rendered to React nodes. Inline HTML — the
 * `<details>`, `<img>` and `<sub>` GitHub bodies are full of — is parsed
 * too, then run through the GitHub-style sanitiser so scripts, handlers and
 * unknown tags never reach the DOM.
 *
 * http(s) links open in the browser, relative ones first resolved against
 * `baseUrl`; `#` links (footnotes, headings) scroll within this block; anything
 * else is `localLink`'s, or plain text, since the window-open handler ignores it. Link clicks never
 * reach an enclosing clickable (a card, a row).
 */
export function GfmMarkdown(props: GfmMarkdownProps) {
  const latest = useRef(props);
  latest.current = props;
  // Made once: a new component type would remount every link and image on each
  // render, dropping focus and reloading the image.
  const [components] = useState<Components>(() => ({
    a: ({ href, id, node, children }) => {
      if (href?.startsWith("#") && href.length > 1) {
        return (
          <InPlaceLink onPress={(e) => jumpTo(e.currentTarget, href)}>{children}</InPlaceLink>
        );
      }
      const url = href ? httpUrl(href, latest.current.baseUrl) : null;
      if (url) {
        return (
          <Link variant="inline" href={url} title={url}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </Link>
        );
      }
      const follow = href ? latest.current.localLink?.(href) : null;
      return follow ? (
        <InPlaceLink title={href} onPress={follow}>
          {children}
        </InPlaceLink>
      ) : (
        // `<a name="install">` stays somewhere `#install` can land.
        <span id={id ?? (node?.properties.name as string | undefined)}>{children}</span>
      );
    },
    img: ({ src, alt, width, height }) => {
      if (typeof src !== "string" || !src) return null;
      const { baseUrl, renderImage, renderLocalImage } = latest.current;
      const url = httpUrl(src, baseUrl);
      const image = {
        src: url ?? src,
        alt,
        width: width === undefined ? undefined : String(width),
        height: height === undefined ? undefined : String(height),
      };
      return url ? renderImage(image) : (renderLocalImage?.(image) ?? null);
    },
  }));

  return (
    <Markdown {...gfmPipeline} components={components}>
      {props.source}
    </Markdown>
  );
}

/** A link that acts in the app rather than opening a browser. */
function InPlaceLink({
  title,
  onPress,
  children,
}: {
  title?: string;
  onPress: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="link"
      className={styles.anchor}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onPress(e);
      }}
    >
      {children}
    </Button>
  );
}

/**
 * Scroll to the element `hash` names, nearest to `from` first so two bodies
 * on screen with the same footnote ids each jump within themselves. `hash`
 * is an unprefixed href (see `gfmPipeline`); the target carries the
 * sanitiser's `user-content-` prefix.
 */
export function jumpTo(from: Element, hash: string) {
  const id = decodeURIComponent(hash.slice(1));
  const selector = `[id="${CSS.escape(`user-content-${id}`)}"]`;
  for (let node = from.parentElement; node; node = node.parentElement) {
    const target = node.querySelector(selector);
    if (target) {
      // A heading goes to the top, to read on from; a footnote only into view.
      const block = target.matches("h1, h2, h3, h4, h5, h6") ? "start" : "nearest";
      target.scrollIntoView({ block, behavior: "smooth" });
      return;
    }
  }
}
