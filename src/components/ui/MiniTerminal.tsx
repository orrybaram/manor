import { useRef, useEffect } from "react";
import {
  useMiniTerminal,
  type UseMiniTerminalReturn,
} from "../../hooks/useMiniTerminal";
import { useMountEffect } from "../../hooks/useMountEffect";

export interface MiniTerminalProps {
  sessionId: string;
  cwd: string | null;
  command: string | null;
  interactive?: boolean;
  onOutput?: (data: string) => void;
  onExit?: () => void;
  autoStart?: boolean;
  className?: string;
}

export interface MiniTerminalHandle {
  start: () => Promise<void>;
  cleanup: () => void;
}

export function MiniTerminal(
  props: MiniTerminalProps & { handleRef?: React.RefObject<MiniTerminalHandle | null> },
) {
  const {
    sessionId,
    cwd,
    command,
    interactive = false,
    onOutput,
    onExit,
    autoStart = true,
    className,
    handleRef,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);

  const terminal: UseMiniTerminalReturn = useMiniTerminal({
    containerRef,
    sessionId,
    cwd,
    command,
    interactive,
    onOutput,
    onExit,
  });

  // Expose imperative handle via ref
  useEffect(() => {
    if (handleRef) {
      (handleRef as React.MutableRefObject<MiniTerminalHandle | null>).current = {
        start: terminal.start,
        cleanup: terminal.cleanup,
      };
    }
  }, [handleRef, terminal.start, terminal.cleanup]);

  // Auto-start on mount if requested
  useEffect(() => {
    if (autoStart) {
      terminal.start();
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useMountEffect(() => terminal.cleanup);

  return <div ref={containerRef} className={className} />;
}
