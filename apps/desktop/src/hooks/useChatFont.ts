import { useLayoutEffect } from "react";
import { chatFontStack } from "../lib/chat-fonts";
import { isWebApp } from "../lib/platform";
import { usePreferencesStore } from "../store/preferences-store";
import { clampFontSize } from "../terminal/config";

const DEFAULT_CHAT_FONT_SIZE = 14;

/** The desk's chat font size for a preference. */
export function resolveChatFontSize(size: unknown): number {
  return clampFontSize(size, DEFAULT_CHAT_FONT_SIZE);
}

/**
 * Put the chat font from Settings on the document, where chat messages and the
 * composer read it, so an open chat redraws in place. With no choice made the
 * family is left unset, and each falls back to the font it always had
 * (`ChatPane.module.css`). A phone or browser tab follows the family too: the
 * choice's fonts are bundled, unlike the terminal's and the editor's. It keeps
 * its own size, even at a width that lays chat out as a desk's.
 */
export function useChatFont(): void {
  const family = usePreferencesStore((s) => s.preferences.chatFontFamily);
  const size = usePreferencesStore((s) => s.preferences.chatFontSize);
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    if (family) root.setProperty("--chat-font-family", chatFontStack(family));
    else root.removeProperty("--chat-font-family");
    if (!isWebApp()) {
      root.setProperty("--chat-font-size", `${resolveChatFontSize(size)}px`);
    }
  }, [family, size]);
}
