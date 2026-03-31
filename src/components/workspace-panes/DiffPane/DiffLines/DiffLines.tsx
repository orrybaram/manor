import { useMemo } from "react";
import type { ReactNode } from "react";
import type { DiffLine } from "../types";
import { extToLang, tokenize } from "../syntax";
import { highlightSyntaxNodes, highlightText } from "./hast-utils";
import styles from "./DiffLines.module.css";

type DiffLinesProps = {
  lines: DiffLine[];
  filePath: string;
  searchQuery: string;
  matchOffset: number;
  currentMatch: number;
};

export function DiffLines(props: DiffLinesProps) {
  const { lines, filePath, searchQuery, matchOffset, currentMatch } = props;
  const tokenizedLines = useMemo(() => {
    const lang = extToLang(filePath);
    if (!lang) return null;
    return lines.map((line) => {
      if (line.type === "hunk") return null;
      return tokenize(line.content, lang);
    });
  }, [lines, filePath]);

  let runningOffset = matchOffset;

  return (
    <table className={styles.table}>
      <tbody>
        {lines.map((line, i) => {
          if (line.type === "hunk") {
            return (
              <tr key={i} className={styles.hunkRow}>
                <td className={styles.lineNum} />
                <td className={styles.hunkContent}>{line.content}</td>
              </tr>
            );
          }
          const numClass =
            line.type === "add" ? styles.lineNumAdd :
            line.type === "del" ? styles.lineNumDel :
            styles.lineNum;
          const contentClass =
            line.type === "add" ? styles.lineContentAdd :
            line.type === "del" ? styles.lineContentDel :
            styles.lineContent;
          const num = line.type === "del" ? line.oldNum : line.newNum;
          const prefix =
            line.type === "add" ? "+" :
            line.type === "del" ? "-" :
            " ";

          let content: ReactNode[];
          let matchCount: number;

          const tokens = tokenizedLines?.[i];
          if (tokens) {
            const result = highlightSyntaxNodes(tokens, searchQuery, runningOffset, currentMatch, `l${i}`);
            content = result.elements;
            matchCount = result.matchCount;
          } else {
            const result = highlightText(line.content, searchQuery, runningOffset, currentMatch);
            content = result.fragments;
            matchCount = result.matchCount;
          }

          runningOffset += matchCount;

          return (
            <tr key={i}>
              <td className={numClass}>{num}</td>
              <td className={contentClass}>
                <span className={styles.prefix}>{prefix}</span>
                {content}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
