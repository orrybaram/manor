import { createElement } from "react";
import type { ReactNode } from "react";
import type { RootContent, Element as HastElement } from "hast";
import styles from "./DiffLines.module.css";

export function hastToReact(nodes: RootContent[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === "text") {
      return node.value;
    }
    if (node.type === "element") {
      const el = node as HastElement;
      const className = Array.isArray(el.properties?.className)
        ? (el.properties.className as string[]).join(" ")
        : undefined;
      return createElement(
        el.tagName,
        { key: `${keyPrefix}-${i}`, className },
        ...hastToReact(el.children as RootContent[], `${keyPrefix}-${i}`),
      );
    }
    return null;
  });
}

export function highlightSyntaxNodes(
  nodes: RootContent[],
  query: string,
  startIndex: number,
  currentMatch: number,
  keyPrefix = "",
): { elements: ReactNode[]; matchCount: number } {
  if (!query) {
    return { elements: hastToReact(nodes, keyPrefix), matchCount: 0 };
  }

  const qLower = query.toLowerCase();
  let globalIdx = startIndex;

  function walkNodes(items: RootContent[], kp: string): ReactNode[] {
    const result: ReactNode[] = [];
    for (let i = 0; i < items.length; i++) {
      const node = items[i];
      if (node.type === "text") {
        const text = node.value;
        const lower = text.toLowerCase();
        let last = 0;
        let pos = lower.indexOf(qLower);
        const frags: ReactNode[] = [];

        while (pos !== -1) {
          if (pos > last) frags.push(text.slice(last, pos));
          frags.push(
            createElement(
              "mark",
              {
                key: `${kp}-m-${pos}`,
                className: globalIdx === currentMatch ? styles.searchMatchActive : styles.searchMatch,
                "data-match-index": globalIdx,
              },
              text.slice(pos, pos + query.length),
            ),
          );
          globalIdx++;
          last = pos + query.length;
          pos = lower.indexOf(qLower, last);
        }

        if (last < text.length) frags.push(text.slice(last));
        if (frags.length > 0) {
          result.push(...frags);
        } else {
          result.push(text);
        }
      } else if (node.type === "element") {
        const el = node as HastElement;
        const className = Array.isArray(el.properties?.className)
          ? (el.properties.className as string[]).join(" ")
          : undefined;
        const children = walkNodes(el.children as RootContent[], `${kp}-${i}`);
        result.push(
          createElement(el.tagName, { key: `${kp}-${i}`, className }, ...children),
        );
      }
    }
    return result;
  }

  const elements = walkNodes(nodes, keyPrefix);
  return { elements, matchCount: globalIdx - startIndex };
}

export function highlightText(
  text: string,
  query: string,
  startIndex: number,
  currentMatch: number,
): { fragments: React.ReactNode[]; matchCount: number } {
  if (!query) return { fragments: [text], matchCount: 0 };

  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const fragments: React.ReactNode[] = [];
  let last = 0;
  let matchCount = 0;

  let pos = lower.indexOf(qLower);
  while (pos !== -1) {
    if (pos > last) fragments.push(text.slice(last, pos));
    const globalIdx = startIndex + matchCount;
    fragments.push(
      <mark
        key={pos}
        className={globalIdx === currentMatch ? styles.searchMatchActive : styles.searchMatch}
        data-match-index={globalIdx}
      >
        {text.slice(pos, pos + query.length)}
      </mark>,
    );
    matchCount++;
    last = pos + query.length;
    pos = lower.indexOf(qLower, last);
  }

  if (last < text.length) fragments.push(text.slice(last));
  return { fragments, matchCount };
}
