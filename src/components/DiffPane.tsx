import { useEffect, useReducer } from "react";
import { html as diff2html } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import styles from "./DiffPane.module.css";

interface DiffPaneProps {
  paneId: string;
}

type DiffState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "loaded"; html: string };

function diffReducer(_state: DiffState, action: DiffState): DiffState {
  return action;
}

export function DiffPane({ paneId }: DiffPaneProps) {
  const workspacePath = useAppStore((s) => s.paneDiffPath[paneId] ?? null);
  const projects = useProjectStore((s) => s.projects);

  const project = projects.find((p) =>
    p.workspaces.some((ws) => ws.path === workspacePath),
  );
  const workspace =
    project?.workspaces.find((ws) => ws.path === workspacePath) ?? null;

  const defaultBranch = project?.defaultBranch ?? "main";
  const branchName = workspace?.branch ?? "";

  const [state, dispatch] = useReducer(diffReducer, { status: "loading" });

  useEffect(() => {
    if (!workspacePath) return;

    let cancelled = false;

    window.electronAPI.diffs
      .getFullDiff(workspacePath, defaultBranch)
      .then((rawDiff) => {
        if (cancelled) return;
        if (!rawDiff || rawDiff.trim() === "") {
          dispatch({ status: "empty" });
        } else {
          const rendered = diff2html(rawDiff, {
            drawFileList: false,
            matching: "lines",
            outputFormat: "line-by-line",
          });
          dispatch({ status: "loaded", html: rendered });
        }
      })
      .catch(() => {
        if (cancelled) return;
        dispatch({ status: "empty" });
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
      {state.status === "loading" && (
        <div className={styles.loading}>Loading diff…</div>
      )}
      {state.status === "empty" && (
        <div className={styles.empty}>No changes</div>
      )}
      {state.status === "loaded" && (
        <div
          className={styles.diffContent}
          dangerouslySetInnerHTML={{ __html: state.html }}
        />
      )}
    </div>
  );
}
