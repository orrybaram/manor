const OSC7 = "\x1b]7;";

/**
 * How a chunk of pty output bears on whether the shell's line editor is up.
 *
 * Manor's OSC 7 hook runs from zsh's precmd / bash's PROMPT_COMMAND — before
 * ZLE or readline switches the tty to raw mode. Until that switch the tty is
 * in canonical mode, where Linux caps a line at 4095 bytes and silently drops
 * the rest, so a long queued command typed on the OSC 7 alone loses its tail
 * and trailing \r and sits unsubmitted at the prompt. The prompt itself is
 * drawn after the switch, so output following the OSC 7 is the safe signal.
 *
 * - `"ready"`: the chunk has output after an OSC 7 terminator.
 * - `"osc7"`: the chunk ends in an OSC 7 with nothing after it (yet).
 * - `"output"`: the chunk has no OSC 7 — it counts as the prompt only when
 *   an OSC 7 came before it.
 */
export function classifyShellOutput(data: string): "ready" | "osc7" | "output" {
  const start = data.lastIndexOf(OSC7);
  if (start < 0) return "output";
  const rest = data.slice(start + OSC7.length);
  const bel = rest.indexOf("\x07");
  const st = rest.indexOf("\x1b\\");
  let end = -1;
  if (bel >= 0 && (st < 0 || bel < st)) end = bel + 1;
  else if (st >= 0) end = st + 2;
  return end >= 0 && end < rest.length ? "ready" : "osc7";
}
