import { useRef, useState } from "react";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import type { Choice, TemplateInfo } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Button } from "../../ui/Button/Button";
import { EmojiInput } from "../../ui/EmojiAutocomplete";
import { Input } from "../../ui/Input";
import { Link } from "../../ui/Link/Link";
import { Row, Stack } from "../../ui/Layout/Layout";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "../../ui/SearchableSelect/SearchableSelect";
import { ToggleGroup } from "../../ui/ToggleGroup/ToggleGroup";
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
  /** Without it the form has no Cancel: the Add a host wizard owns one. */
  onCancel?: () => void;
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
  };

  const run = (work: () => Promise<void>) => {
    setAction({ busy: true, error: null });
    work().then(
      () => setAction({ busy: false, error: null }),
      (err: unknown) => setAction({ busy: false, error: ipcErrorMessage(err) }),
    );
  };

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
        // Keyed, so picking another template starts its form afresh.
        <TemplateForm
          key={template.id}
          template={template}
          busy={busy}
          run={run}
          onStarted={onStarted}
          onCancel={onCancel}
        />
      )}
      {choice === CUSTOM && (
        <CustomRecipe busy={busy} run={run} onStarted={onStarted} onCancel={onCancel} />
      )}
      {choice === "" && onCancel && (
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

type TemplateFormProps = {
  template: TemplateInfo;
  busy: boolean;
  run: (work: () => Promise<void>) => void;
  onStarted: (hostId: string) => void;
  onCancel?: () => void;
};

/**
 * A template's fields and Start. `choice` fields list their options from
 * `hosts.checkTemplate` (ADR-234 D6), asked when the form opens and again
 * whenever the window regains focus, so a context made in a terminal shows
 * up without reopening the form.
 */
function TemplateForm(props: TemplateFormProps) {
  const { template, busy, run, onStarted, onCancel } = props;

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.fields.map((f) => [f.key, f.default ?? ""])),
  );
  // Null until the first check answers.
  const [choices, setChoices] = useState<Record<string, Choice[]> | null>(null);
  // The answers as of the last edit, for a refresh started by focus.
  const valuesRef = useRef(values);
  // Only the latest request's answer is kept.
  const requestRef = useRef(0);
  // Fields the user has edited: a suggested default never overwrites one.
  const touchedRef = useRef(new Set<string>());

  // A suggested answer fills a field only while it is blank and untouched.
  const applyDefaults = (defaults: Record<string, string> | undefined) => {
    if (!defaults) return;
    const current = valuesRef.current;
    const fill = Object.entries(defaults).filter(
      ([key, value]) =>
        value !== "" && (current[key] ?? "") === "" && !touchedRef.current.has(key),
    );
    if (fill.length === 0) return;
    const next = { ...current, ...Object.fromEntries(fill) };
    valuesRef.current = next;
    setValues(next);
  };

  useMountEffect(() => {
    let live = true;
    const refresh = () => {
      const request = ++requestRef.current;
      window.electronAPI.hosts.checkTemplate(template.id, valuesRef.current).then(
        (result) => {
          if (!live || request !== requestRef.current) return;
          setChoices(result.choices);
          applyDefaults(result.defaults);
        },
        () => {
          // Nothing to list: choice fields fall back to typing.
          if (live && request === requestRef.current) setChoices((prev) => prev ?? {});
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  });

  const setValue = (key: string, value: string) => {
    touchedRef.current.add(key);
    const next = { ...valuesRef.current, [key]: value };
    valuesRef.current = next;
    setValues(next);
  };

  const start = () =>
    run(async () => {
      const recipeId = await window.electronAPI.hosts.createRecipe(template.id, values);
      const { hostId } = await window.electronAPI.hosts.addRecipeHost(recipeId);
      onStarted(hostId);
    });

  const missing = template.fields.some((f) => f.required && !(values[f.key] ?? "").trim());

  return (
    <>
      <div className={settingsStyles.fieldHint}>{template.description}</div>
      {template.fields.map((field) => (
        <SettingField key={field.key} label={field.label} hint={field.description}>
          <FieldControl
            field={field}
            value={values[field.key] ?? ""}
            choices={choices === null ? null : (choices[field.key] ?? [])}
            disabled={busy}
            onChange={(value) => setValue(field.key, value)}
          />
        </SettingField>
      ))}
      <Row gap="xs">
        <Button
          variant="primary"
          size="sm"
          data-testid="start-host-submit"
          disabled={busy || missing}
          onClick={start}
        >
          {busy ? "Starting…" : "Start host"}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </Row>
    </>
  );
}

type FieldControlProps = {
  field: TemplateInfo["fields"][number];
  value: string;
  /** A `choice` field's options; null while they are being listed. */
  choices: Choice[] | null;
  disabled: boolean;
  onChange: (value: string) => void;
};

/**
 * One field's control, by its type (ADR-234 D6). A `choice` field with
 * nothing listed, or a `size` field without options, is typed instead, so
 * no field is ever left unfillable.
 */
function FieldControl(props: FieldControlProps) {
  const { field, value, choices, disabled, onChange } = props;

  const testId = `start-host-field-${field.key}`;

  if (field.type === "size" && field.options && field.options.length > 0) {
    return (
      <ToggleGroup
        value={value}
        onChange={onChange}
        options={field.options.map((o) => ({ value: o.value, label: o.label }))}
        size="sm"
        aria-label={field.label}
        data-testid={testId}
      />
    );
  }

  if (field.type === "choice" && (choices === null || choices.length > 0)) {
    const options: SearchableSelectOption[] = [
      // An optional field can be left blank: the template's default applies.
      ...(field.required ? [] : [{ value: "", label: "Default" }]),
      ...(choices ?? []),
      // A value typed in, or no longer listed, stays visible and picked.
      ...(value !== "" && !(choices ?? []).some((c) => c.value === value)
        ? [{ value, label: value }]
        : []),
    ];
    return (
      <SearchableSelect
        value={value}
        onChange={(next) => {
          if (!disabled) onChange(next);
        }}
        options={options}
        placeholder={field.required ? "Pick one…" : "Default"}
        maxWidth={360}
        loading={choices === null}
        onCreate={disabled ? undefined : onChange}
        createLabel={(q) => `Use "${q}"`}
        aria-label={field.label}
        data-testid={testId}
      />
    );
  }

  return (
    <Input
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

type CustomRecipeProps = {
  busy: boolean;
  run: (work: () => Promise<void>) => void;
  onStarted: (hostId: string) => void;
  onCancel?: () => void;
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
            {onCancel && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
            )}
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
            {onCancel && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
            )}
          </Row>
        </>
      )}
    </Stack>
  );
}
