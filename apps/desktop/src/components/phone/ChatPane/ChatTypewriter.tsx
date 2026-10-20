import { useRef, useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ChatMarkdown } from "./ChatMarkdown";

/** Floor on the typing speed, in characters per second. */
const MIN_CPS = 200;

/** A long message still finishes typing within this long. */
const MAX_TYPING_MS = 1_000;

/** The end of the word `pos` falls in, so text appears a word at a time. */
function wordEnd(text: string, pos: number): number {
  const rest = text.slice(pos).search(/\s/);
  return rest === -1 ? text.length : pos + rest;
}

type ChatTypewriterProps = {
  source: string;
};

/**
 * Claude's prose typed out a word at a time, so a reply that arrives whole
 * reads as if it were streaming in. The transcript only has finished
 * messages, so this is purely for show: the full text is already here.
 *
 * Once typed out it renders `source` as is, so a later edit to the entry
 * shows at once. Reduced motion skips straight to the full text.
 */
export function ChatTypewriter(props: ChatTypewriterProps) {
  const { source } = props;

  const latest = useRef(source);
  latest.current = source;
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);

  useMountEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setDone(true);
      return;
    }
    let frame = 0;
    let pos = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const length = latest.current.length;
      const perMs = Math.max(MIN_CPS / 1000, length / MAX_TYPING_MS);
      pos = Math.min(length, pos + (now - last) * perMs);
      last = now;
      if (pos >= length) {
        setDone(true);
        return;
      }
      setShown(wordEnd(latest.current, Math.floor(pos)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  });

  return done ? (
    <ChatMarkdown source={source} />
  ) : (
    <ChatMarkdown source={source.slice(0, shown)} fadeWords />
  );
}
