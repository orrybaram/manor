import { renderPrompt, type PromptOverrides } from "./prompts/catalog";

/**
 * An issue as an agent's first prompt. Anyone who can file or edit the issue
 * wrote its text, and agents often run with permission prompts off, so the
 * text is fenced off and named as a description of the work, not orders. The
 * fence is part of `{{issue}}`'s value: editing the prompt can't remove it.
 */
export function issuePrompt(
  ref: string,
  title: string,
  body: string | null | undefined,
  overrides?: PromptOverrides | null,
): string {
  const fenced = (text: string) => text.replace(/<\/issue>/g, "</ issue>");
  return renderPrompt(
    "issue",
    { ref, title: fenced(title), issue: `<issue>\n${fenced(body ?? "")}\n</issue>` },
    overrides,
  );
}
