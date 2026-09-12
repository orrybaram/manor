import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { getAgentCommand } from "../agent-defaults";
import { escapeShellDoubleQuoted } from "./home";

/**
 * Flatten a prompt to a single line. Prompts here are typed into an
 * interactive shell or a harness's prompt box, and a bare newline either
 * leaves the shell waiting on a continuation prompt or submits the turn
 * early — so every whitespace run that spans a newline collapses to one
 * space before the text is sent.
 */
export function flattenPrompt(prompt: string): string {
  return prompt.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Open a new agent tab in `workspacePath` with `prompt` as its first message.
 *
 * The workspace is selected first — through the project store, so the sidebar
 * highlight and main's persisted selection follow — and the command is queued
 * as that workspace's pending startup command, the same route the command
 * palette's "new agent with prompt" takes. Prewarmed sessions are not consumed:
 * they run the bare agent command, and this one needs the prompt argument.
 */
export function startAgentWithPrompt(
  workspacePath: string,
  prompt: string,
): void {
  const projects = useProjectStore.getState().projects;
  for (const project of projects) {
    const index = project.workspaces.findIndex((w) => w.path === workspacePath);
    if (index >= 0) {
      useProjectStore.getState().selectWorkspace(project.id, index);
      break;
    }
  }

  const app = useAppStore.getState();
  if (app.activeWorkspacePath !== workspacePath) {
    app.setActiveWorkspace(workspacePath);
  }

  const flat = flattenPrompt(prompt);
  const command = `${getAgentCommand(workspacePath)} "${escapeShellDoubleQuoted(flat)}"`;
  useAppStore.getState().setPendingStartupCommand(workspacePath, command);
  useAppStore.getState().addTab();
}
