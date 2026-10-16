import { useRef, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import type { Choice, TemplateCheck, TemplateInfo } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Button } from "../../ui/Button/Button";
import { Collapse } from "../../ui/Collapse/Collapse";
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
import styles from "./HostsPage.module.css";
import { TemplateChecklist } from "./TemplateChecklist";

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

/** How long after the last edit the checklist is asked again. */
const EDIT_DEBOUNCE_MS = 300;
/** How often the checklist is asked again while a check is `busy`. */
const BUSY_POLL_MS = 2000;

type Field = TemplateInfo["fields"][number];

/**
 * A template's Connect step (ADR-234 D7): its everyday fields, the readiness
 * checklist (`hosts.checkTemplate`), an "Advanced" disclosure with the rest,
 * and Start, which waits until every check is `ok` and every required field
 * is filled. The checklist, and the options of `choice` fields, are asked
 * when the form opens, when the window regains focus, shortly after a field
 * changes, right after a fix, and every 2 s while a check is `busy`; only
 * the latest answer is kept.
 */
function TemplateForm(props: TemplateFormProps) {
  const { template, busy, run, onStarted, onCancel } = props;

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.fields.map((f) => [f.key, f.default ?? ""])),
  );
  // Null until the first check answers.
  const [choices, setChoices] = useState<Record<string, Choice[]> | null>(null);
  const [checks, setChecks] = useState<TemplateCheck[] | null>(null);
  // The test id of the `run` fix being carried out.
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The answers as of the last edit, for a refresh started by focus.
  const valuesRef = useRef(values);
  // Only the latest request's answer is kept.
  const requestRef = useRef(0);
  // Fields the user has edited: a suggested default never overwrites one.
  const touchedRef = useRef(new Set<string>());
  // Ask again now, or once edits pause. Null once unmounted.
  const refreshRef = useRef<{ now: () => void; soon: () => void } | null>(null);

  // A suggested answer fills a field only while it is blank and untouched.
  // True when something was filled, so the checklist is asked again.
  const applyDefaults = (defaults: Record<string, string> | undefined): boolean => {
    if (!defaults) return false;
    const current = valuesRef.current;
    const fill = Object.entries(defaults).filter(
      ([key, value]) =>
        value !== "" && (current[key] ?? "") === "" && !touchedRef.current.has(key),
    );
    if (fill.length === 0) return false;
    const next = { ...current, ...Object.fromEntries(fill) };
    valuesRef.current = next;
    setValues(next);
    return true;
  };

  useMountEffect(() => {
    let live = true;
    let debounce: number | undefined;
    let poll: number | undefined;
    const refresh = () => {
      window.clearTimeout(debounce);
      window.clearTimeout(poll);
      const request = ++requestRef.current;
      window.electronAPI.hosts.checkTemplate(template.id, valuesRef.current).then(
        (result) => {
          if (!live || request !== requestRef.current) return;
          setChoices(result.choices);
          setChecks(result.checks);
          // A filled-in cluster changes what the checks find: ask again now.
          if (applyDefaults(result.defaults)) {
            refresh();
            return;
          }
          if (result.checks.some((c) => c.state === "busy")) {
            poll = window.setTimeout(refresh, BUSY_POLL_MS);
          }
        },
        () => {
          // Nothing to list or check: choice fields fall back to typing.
          if (!live || request !== requestRef.current) return;
          setChoices((prev) => prev ?? {});
          setChecks((prev) => prev ?? []);
        },
      );
    };
    const soon = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(refresh, EDIT_DEBOUNCE_MS);
    };
    refreshRef.current = { now: refresh, soon };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      refreshRef.current = null;
      window.clearTimeout(debounce);
      window.clearTimeout(poll);
      window.removeEventListener("focus", refresh);
    };
  });

  const setValue = (key: string, value: string) => {
    touchedRef.current.add(key);
    const next = { ...valuesRef.current, [key]: value };
    valuesRef.current = next;
    setValues(next);
  };

  const edit = (key: string, value: string) => {
    setValue(key, value);
    refreshRef.current?.soon();
  };

  const fix = (check: TemplateCheck) => {
    const action = check.fix;
    if (!action || action.kind === "url") return;
    setFixError(null);
    if (action.kind === "set") {
      setValue(action.key, action.value);
      // Show what changed when it is a field under Advanced.
      if (template.fields.some((f) => f.key === action.key && f.advanced)) setAdvancedOpen(true);
      refreshRef.current?.now();
      return;
    }
    setFixing(action.id);
    window.electronAPI.hosts.runTemplateFix(template.id, action.id, valuesRef.current).then(
      () => {
        setFixing(null);
        // A started job reports `busy`, and polling takes over from there.
        refreshRef.current?.now();
      },
      (err: unknown) => {
        setFixing(null);
        setFixError(ipcErrorMessage(err));
        refreshRef.current?.now();
      },
    );
  };

  const start = () =>
    run(async () => {
      const recipeId = await window.electronAPI.hosts.createRecipe(template.id, values);
      const { hostId } = await window.electronAPI.hosts.addRecipeHost(recipeId);
      onStarted(hostId);
    });

  const visible = template.fields.filter((f) => !f.advanced);
  const advanced = template.fields.filter((f) => f.advanced);
  const missing = template.fields.filter((f) => f.required && !(values[f.key] ?? "").trim());
  const checksReady = checks !== null && checks.every((c) => c.state === "ok");
  const gateHint =
    checks === null
      ? null
      : !checksReady
        ? "Fix the items above to start."
        : missing.length > 0
          ? `Fill in ${missing.map((f) => f.label).join(", ")}${
              missing.some((f) => f.advanced) ? " under Advanced" : ""
            } to start.`
          : null;

  const renderField = (field: Field) => (
    <SettingField key={field.key} label={field.label} hint={field.description}>
      <FieldControl
        field={field}
        value={values[field.key] ?? ""}
        choices={choices === null ? null : (choices[field.key] ?? [])}
        disabled={busy}
        onChange={(value) => edit(field.key, value)}
      />
    </SettingField>
  );

  return (
    <>
      <div className={settingsStyles.fieldHint}>{template.description}</div>
      {visible.map(renderField)}
      <TemplateChecklist checks={checks} fixing={fixing} disabled={busy} onFix={fix} />
      {fixError && (
        <div className={settingsStyles.linearError} data-testid="start-host-fix-error">
          {fixError}
        </div>
      )}
      {advanced.length > 0 && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={advancedOpen}
            data-testid="start-host-advanced"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <ChevronRight
              size={12}
              aria-hidden
              className={`${styles.chevron} ${advancedOpen ? styles.chevronOpen : ""}`}
            />
            Advanced
          </Button>
          <Collapse open={advancedOpen}>
            <Stack gap="sm" className={styles.advancedFields}>
              {advanced.map(renderField)}
            </Stack>
          </Collapse>
        </div>
      )}
      <Row gap="xs" align="center">
        <Button
          variant="primary"
          size="sm"
          data-testid="start-host-submit"
          disabled={busy || missing.length > 0 || !checksReady}
          onClick={start}
        >
          {busy ? "Starting…" : "Start host"}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        {gateHint && !busy && (
          <span className={styles.startHint} data-testid="start-host-gate-hint">
            {gateHint}
          </span>
        )}
      </Row>
    </>
  );
}

type FieldControlProps = {
  field: Field;
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
        // Each size says what it is ("Small · 1 CPU, 2 GiB").
        options={field.options.map((o) => ({
          value: o.value,
          label: o.hint ? (
            <>
              {o.label}
              <span className={styles.sizeHint}>· {o.hint}</span>
            </>
          ) : (
            o.label
          ),
        }))}
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
