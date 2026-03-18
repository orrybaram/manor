import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAppStore } from "../store/app-store";
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

  const addTab = useAppStore((s) => s.addTab);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const selectNextTab = useAppStore((s) => s.selectNextTab);
  const selectPrevTab = useAppStore((s) => s.selectPrevTab);
  const focusNextPane = useAppStore((s) => s.focusNextPane);
  const tabs = useAppStore((s) => s.tabs);
  const selectedTabId = useAppStore((s) => s.selectedTabId);
  const closeTab = useAppStore((s) => s.closeTab);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const commands: Command[] = useMemo(
    () => [
      { id: "new-tab", label: "New Tab", shortcut: "⌘T", action: () => { addTab(); onClose(); } },
      { id: "close-pane", label: "Close Pane", shortcut: "⌘W", action: () => { closePane(); onClose(); } },
      { id: "close-tab", label: "Close Tab", shortcut: "⌘⇧W", action: () => {
        const tab = tabs.find(t => t.id === selectedTabId);
        if (tab) closeTab(tab.id);
        onClose();
      }},
      { id: "split-h", label: "Split Horizontal", shortcut: "⌘D", action: () => { splitPane("horizontal"); onClose(); } },
      { id: "split-v", label: "Split Vertical", shortcut: "⌘⇧D", action: () => { splitPane("vertical"); onClose(); } },
      { id: "next-tab", label: "Next Tab", shortcut: "⌘⇧]", action: () => { selectNextTab(); onClose(); } },
      { id: "prev-tab", label: "Previous Tab", shortcut: "⌘⇧[", action: () => { selectPrevTab(); onClose(); } },
      { id: "next-pane", label: "Next Pane", shortcut: "⌥]", action: () => { focusNextPane(); onClose(); } },
      { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "⌘\\", action: () => { toggleSidebar(); onClose(); } },
    ],
    [addTab, closePane, closeTab, splitPane, selectNextTab, selectPrevTab, focusNextPane, toggleSidebar, onClose, tabs, selectedTabId]
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
