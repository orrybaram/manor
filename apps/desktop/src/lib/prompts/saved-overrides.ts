import { usePreferencesStore } from "../../store/preferences-store";
import type { PromptOverrides } from "./catalog";

/** The prompts edited in Settings, for a builder in the renderer. */
export function savedPromptOverrides(): PromptOverrides | null {
  return usePreferencesStore.getState().preferences.promptOverrides ?? null;
}
