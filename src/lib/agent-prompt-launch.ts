import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { getAgentCommand } from "../agent-defaults";
import { escapeShellDoubleQuoted } from "./home";

/**
 * Open a new agent tab in `workspacePath` with `prompt` as its first message.
 *
 * The workspace is selected first — through the project store, so the sidebar
 * highlight and main's persisted selection follow — and the command is queued
 * as that workspace's pending startup command, the same route the command
 * palette's "new agent with prompt" takes. Prewarmed sessions are not consumed:
 * they run the bare agent command, and this one needs the prompt argument.
 *
 * The prompt is flattened to one line. It is typed into an interactive shell
 * inside double quotes, and a newline there would leave the shell waiting on
 * a continuation prompt rather than starting the agent.
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

  const flat = prompt.replace(/\s*\n\s*/g, " ").trim();
  const command = `${getAgentCommand(workspacePath)} "${escapeShellDoubleQuoted(flat)}"`;
  useAppStore.getState().setPendingStartupCommand(workspacePath, command);
  useAppStore.getState().addTab();
}
