import { useState, useCallback, useRef } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import Check from "lucide-react/dist/esm/icons/check";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useProjectStore, type CustomCommand } from "../../../store/project-store";
import { PROJECT_COLORS } from "../../../project-colors";
import { DEFAULT_AGENT_COMMAND } from "../../../agent-defaults";
import { Input, Textarea } from "@/components/ui/Input";
import styles from "./ProjectSetupWizard.module.css";

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function randomColor(): string | null {
  const colors = PROJECT_COLORS.filter((c) => c.value !== null);
  return colors[Math.floor(Math.random() * colors.length)].value;
}

interface DiscoveredAgent {
  name: string;
  command: string;
}

type ProjectSetupWizardProps = {
  onClose: () => void;
  /** The project ID — project is already created before wizard opens */
  projectId: string;
};

const TOTAL_STEPS = 5;

export function ProjectSetupWizard(props: ProjectSetupWizardProps) {
  const { onClose, projectId } = props;

  const [step, setStep] = useState(0);
  const [color, setColorLocal] = useState<string | null>(null);
  const [agentCommand, setAgentCommand] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [startScript, setStartScript] = useState("");
  const [commands, setCommands] = useState<CustomCommand[]>([]);
  const [linearConnected, setLinearConnected] = useState(false);
  const [linearTeams, setLinearTeams] = useState<
    Array<{ id: string; name: string; key: string }>
  >([]);
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(
    new Set(),
  );
  const [linearLoading, setLinearLoading] = useState(true);
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>(
    [],
  );
  const [agentsLoading, setAgentsLoading] = useState(true);

  const nameRef = useRef<HTMLInputElement>(null);
  const newCommandIdRef = useRef<string | null>(null);

  const project = useProjectStore((s) =>
    s.projects.find((p) => p.id === projectId),
  );
  const updateProject = useProjectStore((s) => s.updateProject);

  const [name, setName] = useState("");

  // Determine total steps dynamically — skip Linear step if not connected
  const totalSteps = linearConnected ? TOTAL_STEPS : TOTAL_STEPS - 1;
  const isLastStep = step === totalSteps - 1;

  // Initialize state from project on mount
  const worktreePathMatchesName = useRef(true);
  useMountEffect(() => {
    if (!project) return;
    setName(project.name ?? "");
    const initialColor = randomColor();
    setColorLocal(initialColor);
    if (initialColor) updateProject(project.id, { color: initialColor });
    setAgentCommand("");
    setStartScript("");
    setCommands(project.commands ?? []);
    const slug = slugify(project.name);
    setWorktreePath(`~/.manor/worktrees/${slug}`);
    worktreePathMatchesName.current = true;
    nameRef.current?.focus();
  });

  // Discover available agents on mount
  useMountEffect(() => {
    let cancelled = false;
    setAgentsLoading(true);
    window.electronAPI.shell
      .discoverAgents()
      .then((agents) => {
        if (!cancelled) {
          setDiscoveredAgents(agents);
          if (agents.length > 0) setAgentCommand(agents[0].command);
        }
      })
      .catch(() => {
        if (!cancelled) setDiscoveredAgents([]);
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  });

  // Check Linear connection on mount
  useMountEffect(() => {
    let cancelled = false;
    setLinearLoading(true);
    window.electronAPI.linear
      .isConnected()
      .then(async (connected) => {
        if (cancelled) return;
        setLinearConnected(connected);
        if (connected) {
          try {
            const teams = await window.electronAPI.linear.getTeams();
            if (!cancelled) setLinearTeams(teams);
          } catch {
            if (!cancelled) setLinearTeams([]);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setLinearConnected(false);
      })
      .finally(() => {
        if (!cancelled) setLinearLoading(false);
      });
    return () => {
      cancelled = true;
    };
  });

  const setColor = useCallback(
    (newColor: string | null) => {
      setColorLocal(newColor);
      updateProject(projectId, { color: newColor });
    },
    [projectId, updateProject],
  );

  // Debounce name updates to the store for sidebar reactivity
  const nameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useMountEffect(() => {
    return () => {
      if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
    };
  });
  const handleNameChange = useCallback(
    (newName: string) => {
      setName(newName);
      if (worktreePathMatchesName.current) {
        const slug = slugify(newName);
        setWorktreePath(`~/.manor/worktrees/${slug}`);
      }
      // Debounce store update for sidebar
      if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
      const trimmed = newName.trim();
      if (trimmed) {
        nameTimerRef.current = setTimeout(() => {
          updateProject(projectId, { name: trimmed });
        }, 300);
      }
    },
    [projectId, updateProject],
  );

  const handleWorktreePathChange = useCallback((value: string) => {
    worktreePathMatchesName.current = false;
    setWorktreePath(value);
  }, []);

  const handleToggleTeam = useCallback((teamId: string) => {
    setSelectedTeamIds((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      return next;
    });
  }, []);

  // Save current step's settings to the project
  const saveCurrentStep = useCallback(async () => {
    switch (step) {
      case 0: {
        const updates: Record<string, unknown> = {};
        const trimmedName = name.trim();
        if (trimmedName && trimmedName !== project?.name) {
          updates.name = trimmedName;
        }
        if (color) updates.color = color;
        if (Object.keys(updates).length > 0) {
          await updateProject(projectId, updates);
        }
        break;
      }
      case 1: {
        if (agentCommand.trim()) {
          await updateProject(projectId, {
            agentCommand: agentCommand.trim(),
          });
        }
        break;
      }
      case 2: {
        const updates: Record<string, unknown> = {};
        if (worktreePath.trim()) {
          updates.worktreePath = worktreePath.trim();
        }
        if (startScript.trim()) {
          updates.worktreeStartScript = startScript.trim();
        }
        if (Object.keys(updates).length > 0) {
          await updateProject(projectId, updates);
        }
        break;
      }
      case 3: {
        const nonEmpty = commands.filter(
          (c) => c.name.trim() || c.command.trim(),
        );
        await updateProject(projectId, { commands: nonEmpty });
        break;
      }
      case 4: {
        if (selectedTeamIds.size > 0) {
          await updateProject(projectId, {
            linearAssociations: linearTeams
              .filter((t) => selectedTeamIds.has(t.id))
              .map((t) => ({
                teamId: t.id,
                teamName: t.name,
                teamKey: t.key,
              })),
          });
        }
        break;
      }
    }
  }, [
    step,
    projectId,
    name,
    color,
    agentCommand,
    worktreePath,
    startScript,
    commands,
    selectedTeamIds,
    linearTeams,
    project?.name,
    updateProject,
  ]);

  const handleDone = useCallback(async () => {
    await saveCurrentStep();
    onClose();
  }, [saveCurrentStep, onClose]);

  const handleAdvance = useCallback(async () => {
    if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
    await saveCurrentStep();
    setStep((s) => s + 1);
  }, [saveCurrentStep]);

  const handleBack = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  const handleSkip = useCallback(() => {
    if (isLastStep) {
      onClose();
    } else {
      setStep((s) => s + 1);
    }
  }, [isLastStep, onClose]);

  // Enter advances / completes
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (isLastStep) {
          handleDone();
        } else {
          handleAdvance();
        }
      }
    },
    [isLastStep, handleDone, handleAdvance],
  );

  // Command helpers
  const handleAddCommand = useCallback(() => {
    const id = crypto.randomUUID();
    newCommandIdRef.current = id;
    setCommands((prev) => [...prev, { id, name: "", command: "" }]);
  }, []);

  const handleUpdateCommand = useCallback(
    (id: string, field: "name" | "command", value: string) => {
      setCommands((prev) =>
        prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
      );
    },
    [],
  );

  const handleDeleteCommand = useCallback((id: string) => {
    setCommands((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const renderStepContent = () => {
    switch (step) {
      case 0:
        return (
          <div className={styles.stepContainer}>
            <div className={styles.stepHeader}>
              <div className={styles.stepTitle}>Name & Color</div>
              <div className={styles.stepHint}>
                Give your project a name and pick a color.
              </div>
            </div>
            <label className={styles.fieldLabel}>Project Name
            <Input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="my-project"
              autoFocus
            />
            </label>
            <div className={styles.fieldLabel}>
            <label className={styles.fieldLabel}>Color</label>
            <div className={styles.colorPicker}>
              {PROJECT_COLORS.filter((c) => c.value !== null).map((c) => {
                const isSelected = color === c.value;
                return (
                  <button
                    key={c.value}
                    type="button"
                    className={`${styles.colorOption} ${isSelected ? styles.colorOptionSelected : ""}`}
                    style={{ background: `var(${c.cssVar})` }}
                    title={c.label}
                    onClick={() => setColor(c.value)}
                  >
                    {isSelected && (
                      <Check size={10} strokeWidth={3} color="var(--bg)" />
                    )}
                  </button>
                );
              })}
            </div>
            </div>
          </div>
        );

      case 1:
        return (
          <div className={styles.stepContainer}>
            <div className={styles.stepHeader}>
              <div className={styles.stepTitle}>Agent Command</div>
              <div className={styles.stepHint}>
                The command Manor runs when you open a new terminal pane.
              </div>
            </div>
            {agentsLoading ? (
              <div className={styles.agentDiscovery}>
                <Loader2 size={14} className={styles.spinner} />
                <span className={styles.agentDiscoveryHint}>
                  Looking for agents...
                </span>
              </div>
            ) : discoveredAgents.length > 0 ? (
              <div className={styles.agentList}>
                {discoveredAgents.map((agent) => {
                  const isSelected = agentCommand === agent.command;
                  return (
                    <button
                      key={agent.command}
                      type="button"
                      className={`${styles.agentOption} ${isSelected ? styles.agentOptionSelected : ""}`}
                      onClick={() => setAgentCommand(agent.command)}
                    >
                      <span
                        className={`${styles.agentRadio} ${isSelected ? styles.agentRadioSelected : ""}`}
                      />
                      <span>
                        <span className={styles.agentName}>{agent.name}</span>
                        <span className={styles.agentCommandText}>
                          {agent.command}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className={styles.agentDiscovery}>
                <span className={styles.agentDiscoveryHint}>
                  No known agents found on your system.
                </span>
              </div>
            )}
            <label className={styles.fieldLabel}>
              {discoveredAgents.length > 0
                ? "Or enter a custom command"
                : "Command"}
            <Input
              type="text"
              value={agentCommand}
              onChange={(e) => setAgentCommand(e.target.value)}
              placeholder={DEFAULT_AGENT_COMMAND}
              autoFocus={discoveredAgents.length === 0}
            />
            </label>

          </div>
        );

      case 2:
        return (
          <div className={styles.stepContainer}>
            <div className={styles.stepHeader}>
              <div className={styles.stepTitle}>Worktree Path</div>
              <div className={styles.stepHint}>
                Where Manor creates git worktrees for branch-based workspaces.
              </div>
            </div>
            <label className={styles.fieldLabel}>Path
            <Input
              type="text"
              value={worktreePath}
              onChange={(e) => handleWorktreePathChange(e.target.value)}
              placeholder="~/.manor/worktrees/my-project"
              autoFocus
            />
            </label>
            <label className={styles.fieldLabel}>Setup Script
            <Textarea
              rows={4}
              value={startScript}
              onChange={(e) => setStartScript(e.target.value)}
              placeholder="Runs in the terminal when a new worktree is created"
            />
            </label>
          </div>
        );

      case 3:
        return (
          <div className={styles.stepContainer}>
            <div className={styles.stepHeader}>
              <div className={styles.stepTitle}>Commands</div>
              <div className={styles.stepHint}>
                Add custom commands you can run from the command palette.
              </div>
            </div>
            <div className={styles.commandList}>
              {commands.map((cmd) => (
                <div key={cmd.id} className={styles.commandRow}>
                  <input
                    ref={(el) => {
                      if (el && cmd.id === newCommandIdRef.current) {
                        el.focus();
                        newCommandIdRef.current = null;
                      }
                    }}
                    className={styles.commandNameInput}
                    value={cmd.name}
                    placeholder="Name"
                    onChange={(e) =>
                      handleUpdateCommand(cmd.id, "name", e.target.value)
                    }
                    onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
                  />
                  <input
                    className={styles.commandCmdInput}
                    value={cmd.command}
                    placeholder="Command"
                    onChange={(e) =>
                      handleUpdateCommand(cmd.id, "command", e.target.value)
                    }
                    onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
                  />
                  <button
                    type="button"
                    className={styles.commandDeleteBtn}
                    onClick={() => handleDeleteCommand(cmd.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={styles.addCommandBtn}
                onClick={handleAddCommand}
              >
                <Plus size={12} />
                Add Command
              </button>
            </div>
          </div>
        );

      case 4:
        return (
          <div className={styles.stepContainer}>
            <div className={styles.stepHeader}>
              <div className={styles.stepTitle}>Linear Integration</div>
              <div className={styles.stepHint}>
                Link Linear teams to this project to see issues in the sidebar.
              </div>
            </div>
            {linearLoading ? (
              <div className={styles.linearHint}>
                <Loader2 size={14} className={styles.spinner} /> Loading
                teams...
              </div>
            ) : linearTeams.length === 0 ? (
              <div className={styles.linearHint}>
                No teams found in your Linear workspace.
              </div>
            ) : (
              <div className={styles.teamList}>
                {linearTeams.map((team) => {
                  const isSelected = selectedTeamIds.has(team.id);
                  return (
                    <button
                      key={team.id}
                      type="button"
                      className={styles.teamItem}
                      onClick={() => handleToggleTeam(team.id)}
                    >
                      <span
                        className={`${styles.teamCheck} ${isSelected ? styles.teamCheckSelected : ""}`}
                      >
                        {isSelected && (
                          <Check size={10} strokeWidth={3} color="var(--bg)" />
                        )}
                      </span>
                      {team.key} — {team.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.card} onKeyDown={handleKeyDown}>
        <div className={styles.header}>
          <div className={styles.title}>Project Setup</div>
          <div className={styles.steps}>
            {Array.from({ length: totalSteps }, (_, i) => (
              <div
                key={i}
                className={`${styles.stepDot} ${
                  i < step
                    ? styles.stepDotCompleted
                    : i === step
                      ? styles.stepDotActive
                      : ""
                }`}
              />
            ))}
          </div>
        </div>

        <div className={styles.body}>{renderStepContent()}</div>

        <div className={styles.footer}>
          {step > 0 ? (
            <button
              type="button"
              className={styles.backButton}
              onClick={handleBack}
            >
              Back
            </button>
          ) : (
            <div />
          )}
          <div className={styles.footerRight}>
            <button
              type="button"
              className={styles.skipButton}
              onClick={handleSkip}
            >
              Skip
            </button>
            <button
              type="button"
              className={styles.nextButton}
              onClick={isLastStep ? handleDone : handleAdvance}
            >
              {isLastStep ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
