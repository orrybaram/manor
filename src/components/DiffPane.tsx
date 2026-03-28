import { useEffect, useState } from "react";
import { html as diff2html } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import styles from "./DiffPane.module.css";

interface DiffPaneProps {
  paneId: string;
}

export function DiffPane({ paneId }: DiffPaneProps) {
  const paneDiffPath = useAppStore((s) => s.paneDiffPath);
  const workspacePath = paneDiffPath[paneId] ?? null;

  const projects = useProjectStore((s) => s.projects);

  // Find the project containing this workspace path
  const project = projects.find((p) =>
    p.workspaces.some((ws) => ws.path === workspacePath),
  );
  const workspace = project?.workspaces.find(
    (ws) => ws.path === workspacePath,
  ) ?? null;

  const defaultBranch = project?.defaultBranch ?? "main";
  const branchName = workspace?.branch ?? "";

  const [diffHtml, setDiffHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isEmpty, setIsEmpty] = useState(false);

  useEffect(() => {
    if (!workspacePath) return;

    let cancelled = false;
    setLoading(true);
    setDiffHtml(null);
    setIsEmpty(false);

    window.electronAPI.diffs
      .getFullDiff(workspacePath, defaultBranch)
      .then((rawDiff) => {
        if (cancelled) return;
        if (!rawDiff || rawDiff.trim() === "") {
          setIsEmpty(true);
          setDiffHtml(null);
        } else {
          const rendered = diff2html(rawDiff, {
            drawFileList: false,
            matching: "lines",
            outputFormat: "line-by-line",
          });
          setDiffHtml(rendered);
          setIsEmpty(false);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setIsEmpty(true);
        setDiffHtml(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspacePath, defaultBranch]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        Diff: <strong>{branchName || "HEAD"}</strong> vs{" "}
        <strong>{defaultBranch}</strong>
      </div>
      {loading && (
        <div className={styles.loading}>Loading diff…</div>
      )}
      {!loading && isEmpty && (
        <div className={styles.empty}>No changes</div>
      )}
      {!loading && diffHtml && (
        <div
          className={styles.diffContent}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: diffHtml }}
        />
      )}
    </div>
  );
}
