import { useLayoutEffect } from "react";
import { chatFontStack } from "../lib/chat-fonts";
import { usePreferencesStore } from "../store/preferences-store";
import { clampFontSize } from "../terminal/config";

const DEFAULT_CHAT_FONT_SIZE = 14;

/** The desk's chat font size for a preference. */
export function resolveChatFontSize(size: unknown): number {
  return clampFontSize(size, DEFAULT_CHAT_FONT_SIZE);
}

/**
 * Put the chat font from Settings on the document, where chat messages and the
 * composer read it, so an open chat redraws in place. A phone or browser tab
 * follows the family too: the choice's fonts are bundled, unlike the terminal's
 * and the editor's. The size applies only to the desk layout (`ChatPane.module.css`).
 */
export function useChatFont(): void {
  const family = usePreferencesStore((s) => s.preferences.chatFontFamily);
  const size = usePreferencesStore((s) => s.preferences.chatFontSize);
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--chat-font-family", chatFontStack(family ?? ""));
    root.setProperty("--chat-font-size", `${resolveChatFontSize(size)}px`);
  }, [family, size]);
}
