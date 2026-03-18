import { useCallback, useRef, useState } from "react";
import type { PaneNode } from "../store/pane-tree";
import { TerminalPane } from "./TerminalPane";
import { useAppStore } from "../store/app-store";

interface PaneLayoutProps {
  node: PaneNode;
}

export function PaneLayout({ node }: PaneLayoutProps) {
  if (node.type === "leaf") {
    return <LeafPane paneId={node.paneId} />;
  }

  return (
    <SplitLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
    />
  );
}

function LeafPane({ paneId }: { paneId: string }) {
  const focusedPaneId = useAppStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.selectedTabId);
    return tab?.focusedPaneId;
  });
  const focusPane = useAppStore((s) => s.focusPane);
  const isFocused = focusedPaneId === paneId;

  return (
    <div
      className={`pane-leaf ${isFocused ? "pane-focused" : ""}`}
      onMouseDown={() => focusPane(paneId)}
    >
      <TerminalPane paneId={paneId} />
    </div>
  );
}

interface SplitLayoutProps {
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

function SplitLayout({ direction, ratio, first, second }: SplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentRatio, setCurrentRatio] = useState(ratio);
  const [isDragging, setIsDragging] = useState(false);

  const isHorizontal = direction === "horizontal";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const container = containerRef.current;
      if (!container) return;

      const onMouseMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        let newRatio: number;
        if (isHorizontal) {
          newRatio = (ev.clientX - rect.left) / rect.width;
        } else {
          newRatio = (ev.clientY - rect.top) / rect.height;
        }
        newRatio = Math.max(0.1, Math.min(0.9, newRatio));
        setCurrentRatio(newRatio);
      };

      const onMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [isHorizontal]
  );

  const firstSize = `${currentRatio * 100}%`;
  const secondSize = `${(1 - currentRatio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`pane-split ${isHorizontal ? "split-horizontal" : "split-vertical"}`}
    >
      <div className="pane-split-child" style={isHorizontal ? { width: firstSize } : { height: firstSize }}>
        <PaneLayout node={first} />
      </div>
      <div
        className={`pane-divider ${isHorizontal ? "divider-horizontal" : "divider-vertical"} ${isDragging ? "divider-active" : ""}`}
        onMouseDown={handleMouseDown}
      />
      <div className="pane-split-child" style={isHorizontal ? { width: secondSize } : { height: secondSize }}>
        <PaneLayout node={second} />
      </div>
    </div>
  );
}
