import type { Page } from "@playwright/test";

/** Catppuccin Latte, applied directly when the theme list isn't loaded (as `agents-modal.spec.ts`). */
export async function useTheme(w: Page, name: "Catppuccin Latte" | "Catppuccin Mocha") {
  await w.evaluate((n) => window.electronAPI.theme.setSelected(n), name).catch(() => {});
  await w.waitForTimeout(800);
  const want = name === "Catppuccin Latte" ? "light" : "dark";
  const scheme = await w.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  if (scheme === want) return;
  await w.evaluate((light) => {
    const vars: Record<string, string> = light
      ? {
          "--bg": "#eff1f5", "--fg": "#4c4f69", "--dim": "#e6e9ef", "--surface": "#ccd0da",
          "--hover": "#dce0e8", "--border": "#bcc0cc", "--control-border": "#4c4f6940",
          "--text-primary": "#4c4f69b3", "--text-selected": "#4c4f69", "--text-dim": "#4c4f6980",
          "--accent": "#1e66f5", "--green": "#40a02b", "--red": "#d20f39", "--yellow": "#df8e1d",
        }
      : {
          "--bg": "#1e1e2e", "--fg": "#cdd6f4", "--dim": "#181825", "--surface": "#313244",
          "--hover": "#2a2a3c", "--border": "#383850", "--control-border": "#cdd6f440",
          "--text-primary": "#cdd6f4b3", "--text-selected": "#cdd6f4", "--text-dim": "#cdd6f466",
          "--accent": "#89b4fa", "--green": "#a6e3a1", "--red": "#f38ba8", "--yellow": "#f9e2af",
        };
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    document.documentElement.style.colorScheme = light ? "light" : "dark";
  }, want === "light");
}
