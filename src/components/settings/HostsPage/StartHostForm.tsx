import { useState } from "react";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import type { TemplateInfo } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Button } from "../../ui/Button/Button";
import { EmojiInput } from "../../ui/EmojiAutocomplete";
import { Input } from "../../ui/Input";
import { Link } from "../../ui/Link/Link";
import { Row, Stack } from "../../ui/Layout/Layout";
import { SearchableSelect } from "../../ui/SearchableSelect/SearchableSelect";
import { SettingField } from "../SettingRow";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";

/** Where the recipe contract and a worked ssh example are (ADR-229 D8). */
export const RECIPES_DOCS_URL = "https://github.com/orrybaram/manor/blob/main/docs/hosts/recipes.md";

const CUSTOM = "__custom__";

type StartHostFormProps = {
  /**
   * A host was registered from a recipe and is starting: its `up` runs, and
   * its progress streams into its status on the page.
   */
  onStarted: (hostId: string) => void;
  onCancel: () => void;
};

/**
 * "Start a host" (ADR-229 D8): a bundled template's short form, or a custom
 * recipe. A template is written as a recipe (`hosts.createRecipe`) and a
 * host is started from it (`hosts.addRecipeHost`). A custom recipe starts as
 * a folder with `recipe.json` and an `up.sh` to finish, revealed in the file
 * manager; the host is started from it once the user says it is ready.
 */
export function StartHostForm(props: StartHostFormProps) {
  const { onStarted, onCancel } = props;

  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [choice, setChoice] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [action, setAction] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const { busy, error } = action;

  useMountEffect(() => {
    let live = true;
    window.electronAPI.hosts.listTemplates().then(
      (list) => {
        if (live) setTemplates(list);
      },
      (err: unknown) => {
        if (!live) return;
        setTemplates([]);
        setAction({ busy: false, error: ipcErrorMessage(err) });
      },
    );
    return () => {
      live = false;
    };
  });

  const template = templates?.find((t) => t.id === choice) ?? null;
  const options = [
    ...(templates ?? []).map((t) => ({ value: t.id, label: t.name })),
    { value: CUSTOM, label: "Custom recipe" },
  ];

  const pick = (id: string) => {
    setChoice(id);
    setAction({ busy: false, error: null });
    const picked = templates?.find((t) => t.id === id);
    setValues(
      Object.fromEntries((picked?.fields ?? []).map((f) => [f.key, f.default ?? ""])),
    );
  };

  const run = (work: () => Promise<void>) => {
    setAction({ busy: true, error: null });
    work().then(
      () => setAction({ busy: false, error: null }),
      (err: unknown) => setAction({ busy: false, error: ipcErrorMessage(err) }),
    );
  };

  const startFromTemplate = (picked: TemplateInfo) =>
    run(async () => {
      const recipeId = await window.electronAPI.hosts.createRecipe(picked.id, values);
      const { hostId } = await window.electronAPI.hosts.addRecipeHost(recipeId);
      onStarted(hostId);
    });

  const missing = template?.fields.some((f) => f.required && !(values[f.key] ?? "").trim()) ?? false;

  return (
    <Stack gap="sm" data-testid="start-host-form">
      <SearchableSelect
        value={choice}
        placeholder={templates === null ? "Loading templates…" : "Pick a template…"}
        onChange={pick}
        options={options}
        maxWidth={260}
        loading={templates === null}
        aria-label="Template"
        data-testid="start-host-template"
      />
      {template && (
        <>
          <div className={settingsStyles.fieldHint}>{template.description}</div>
          {template.fields.map((field) => (
            <SettingField key={field.key} label={field.label} hint={field.description}>
              <Input
                data-testid={`start-host-field-${field.key}`}
                value={values[field.key] ?? ""}
                disabled={busy}
                onChange={(e) => {
                  const value = e.target.value;
                  setValues((v) => ({ ...v, [field.key]: value }));
                }}
              />
            </SettingField>
          ))}
          <Row gap="xs">
            <Button
              variant="primary"
              size="sm"
              data-testid="start-host-submit"
              disabled={busy || missing}
              onClick={() => startFromTemplate(template)}
            >
              {busy ? "Starting…" : "Start host"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </Row>
        </>
      )}
      {choice === CUSTOM && (
        <CustomRecipe busy={busy} run={run} onStarted={onStarted} onCancel={onCancel} />
      )}
      {choice === "" && (
        <div>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <div className={settingsStyles.linearError} data-testid="start-host-error">
          {error}
        </div>
      )}
    </Stack>
  );
}

type CustomRecipeProps = {
  busy: boolean;
  run: (work: () => Promise<void>) => void;
  onStarted: (hostId: string) => void;
  onCancel: () => void;
};

/** A custom recipe: the contract in two lines, its folder, then starting it. */
function CustomRecipe(props: CustomRecipeProps) {
  const { busy, run, onStarted, onCancel } = props;

  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ recipeId: string; file: string } | null>(null);

  const createFolder = () =>
    run(async () => {
      const result = await window.electronAPI.hosts.createCustomRecipe(name);
      setCreated(result);
      await window.electronAPI.shell.showItemInFolder(result.file);
    });

  const start = (recipeId: string) =>
    run(async () => {
      const { hostId } = await window.electronAPI.hosts.addRecipeHost(recipeId);
      onStarted(hostId);
    });

  return (
    <Stack gap="xs" data-testid="start-host-custom">
      <div className={settingsStyles.fieldHint}>
        A recipe is your own <code>up</code> script, run on this computer: it starts the host
        and prints how to reach it, over ssh or a command like <code>docker exec</code>.{" "}
        <code>stop</code>, <code>status</code> and <code>destroy</code> are optional.{" "}
        <Link href={RECIPES_DOCS_URL}>How recipes work</Link>
      </div>
      {created ? (
        <>
          <div className={settingsStyles.fieldHint} data-testid="start-host-custom-created">
            Finish <code>up.sh</code> in {created.file.replace(/recipe\.json$/, "")}, then start it.
          </div>
          <Row gap="xs">
            <Button
              variant="primary"
              size="sm"
              data-testid="start-host-custom-start"
              disabled={busy}
              onClick={() => start(created.recipeId)}
            >
              {busy ? "Starting…" : "Start host"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void window.electronAPI.shell.showItemInFolder(created.file)}
            >
              <FolderOpen size={12} aria-hidden />
              Show folder
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </Row>
        </>
      ) : (
        <>
          <SettingField label="Host name" hint="How Manor names the host.">
            <EmojiInput
              data-testid="start-host-custom-name"
              placeholder="e.g. Build VM"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </SettingField>
          <Row gap="xs">
            <Button
              variant="secondary"
              size="sm"
              data-testid="start-host-custom-create"
              disabled={busy || name.trim() === ""}
              onClick={createFolder}
            >
              Create recipe folder
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </Row>
        </>
      )}
    </Stack>
  );
}
