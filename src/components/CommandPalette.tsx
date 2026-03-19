import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { useProjectStore } from "../store/project-store";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const addSession = useAppStore((s) => s.addSession);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const selectNextSession = useAppStore((s) => s.selectNextSession);
  const selectPrevSession = useAppStore((s) => s.selectPrevSession);
  const focusNextPane = useAppStore((s) => s.focusNextPane);
  const ws = useAppStore(selectActiveWorkspace);
  const sessions = ws?.sessions ?? [];
  const selectedSessionId = ws?.selectedSessionId ?? null;
  const closeSession = useAppStore((s) => s.closeSession);
  const zoomIn = useAppStore((s) => s.zoomIn);
  const zoomOut = useAppStore((s) => s.zoomOut);
  const resetZoom = useAppStore((s) => s.resetZoom);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const commands: Command[] = useMemo(
    () => [
      { id: "new-session", label: "New Session", shortcut: "⌘T", action: () => { addSession(); onClose(); } },
      { id: "close-pane", label: "Close Pane", shortcut: "⌘W", action: () => { closePane(); onClose(); } },
      { id: "close-session", label: "Close Session", shortcut: "⌘⇧W", action: () => {
        const session = sessions.find(s => s.id === selectedSessionId);
        if (session) closeSession(session.id);
        onClose();
      }},
      { id: "split-h", label: "Split Horizontal", shortcut: "⌘D", action: () => { splitPane("horizontal"); onClose(); } },
      { id: "split-v", label: "Split Vertical", shortcut: "⌘⇧D", action: () => { splitPane("vertical"); onClose(); } },
      { id: "next-session", label: "Next Session", shortcut: "⌘⇧]", action: () => { selectNextSession(); onClose(); } },
      { id: "prev-session", label: "Previous Session", shortcut: "⌘⇧[", action: () => { selectPrevSession(); onClose(); } },
      { id: "next-pane", label: "Next Pane", shortcut: "⌥]", action: () => { focusNextPane(); onClose(); } },
      { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "⌘\\", action: () => { toggleSidebar(); onClose(); } },
      { id: "zoom-in", label: "Zoom In", shortcut: "⌘=", action: () => { zoomIn(); onClose(); } },
      { id: "zoom-out", label: "Zoom Out", shortcut: "⌘-", action: () => { zoomOut(); onClose(); } },
      { id: "zoom-reset", label: "Reset Zoom", shortcut: "⌘0", action: () => { resetZoom(); onClose(); } },
    ],
    [addSession, closePane, closeSession, splitPane, selectNextSession, selectPrevSession, focusNextPane, toggleSidebar, zoomIn, zoomOut, resetZoom, onClose, sessions, selectedSessionId]
  );

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [query, commands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].action();
        }
      }
    },
    [filtered, selectedIndex, onClose]
  );

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-list">
          {filtered.map((cmd, idx) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${idx === selectedIndex ? "selected" : ""}`}
              onClick={() => cmd.action()}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span className="command-palette-label">{cmd.label}</span>
              {cmd.shortcut && (
                <span className="command-palette-shortcut">{cmd.shortcut}</span>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="command-palette-empty">No matching commands</div>
          )}
        </div>
      </div>
    </div>
  );
}
