import { useRef, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import type { Choice, HostProfile, TemplateCheck, TemplateInfo } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Button } from "../../ui/Button/Button";
import { Checkbox } from "../../ui/Checkbox/Checkbox";
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
import { ProfileSignIn } from "./ProfileSignIn";
import { ClusterGuide } from "./ClusterGuide";
import { TemplateChecklist } from "./TemplateChecklist";

/** Where the recipe contract and a worked ssh example are. */
export const RECIPES_DOCS_URL =
  "https://github.com/orrybaram/manor/blob/main/docs/hosts/recipes.md";

const CUSTOM = "__custom__";

type StartHostFormProps = {
  /**
   * A host was registered from a recipe and is starting: its `up` runs, and
   * its progress streams into its status on the page.
   */
  onStarted?: (hostId: string) => void;
  /** Without it the form has no Cancel: the Add a host wizard owns one. */
  onCancel?: () => void;
  /**
   * "host" starts a host; "profile" saves a profile instead:
   * no per-host fields, a Name and idle stop, and no custom recipe.
   */
  mode?: "host" | "profile";
  /** Profile mode: the profile being edited; absent makes a new one. */
  profile?: HostProfile;
  /** Profile mode: the profile was saved. */
  onSaved?: (profile: HostProfile) => void;
};

/**
 * "Start a host": a bundled template's short form, or a custom
 * recipe. A template is written as a recipe (`hosts.createRecipe`) and a
 * host is started from it (`hosts.addRecipeHost`). A custom recipe starts as
 * a folder with `recipe.json` and an `up.sh` to finish, revealed in the file
 * manager; the host is started from it once the user says it is ready.
 */
export function StartHostForm(props: StartHostFormProps) {
  const { onStarted, onCancel, mode = "host", profile, onSaved } = props;

  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [choice, setChoice] = useState(profile?.templateId ?? "");
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
    ...(mode === "host" ? [{ value: CUSTOM, label: "Custom recipe" }] : []),
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
      {!profile && (
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
      )}
      {template && (
        // Keyed, so picking another template starts its form afresh.
        <TemplateForm
          key={template.id}
          template={template}
          busy={busy}
          run={run}
          onStarted={onStarted}
          onCancel={onCancel}
          mode={mode}
          profile={profile}
          onSaved={onSaved}
        />
      )}
      {choice === CUSTOM && mode === "host" && (
        <CustomRecipe busy={busy} run={run} onStarted={onStarted ?? noop} onCancel={onCancel} />
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
  onStarted?: (hostId: string) => void;
  onCancel?: () => void;
  mode: "host" | "profile";
  profile?: HostProfile;
  onSaved?: (profile: HostProfile) => void;
};

const noop = () => {};

/** "Stop when idle for": minutes as text, "" for Off. */
const IDLE_OPTIONS = [
  { value: "", label: "Off" },
  { value: "30", label: "30 min" },
  { value: "60", label: "60 min" },
  { value: "120", label: "120 min" },
];

/** How long after the last edit the checklist is asked again. */
const EDIT_DEBOUNCE_MS = 300;
/** How often the checklist is asked again while a check is `busy`. */
const BUSY_POLL_MS = 2000;
/**
 * How often the checklist is asked again while "Where's your cluster?" shows.
 * Polling rather than a file watch pushed from main: `kubectl config view` is
 * cheap, it honours `$KUBECONFIG` and merged files exactly as kubectl will,
 * and no push channel exists to reuse; a watcher would need a new one, and
 * would miss a kubeconfig created in a directory that did not exist yet.
 */
const GUIDE_POLL_MS = 3000;

/**
 * Whether kubectl works but knows of no cluster: the case for the cluster
 * guide. A missing kubectl is the checklist's to explain.
 */
function needsCluster(
  templateId: string,
  result: { checks: TemplateCheck[]; choices: Record<string, Choice[]> },
): boolean {
  return (
    templateId === "kubernetes" &&
    (result.choices.context ?? []).length === 0 &&
    result.checks.some((c) => c.id === "kubectl-cli" && c.state === "ok")
  );
}

type Field = TemplateInfo["fields"][number];

/**
 * Whether `field` is shown for these answers: always, unless it has a
 * `showWhen` whose field has another answer (the SSH target, while "Run it
 * on" is "This computer"). A hidden field is not required.
 */
function isFieldShown(field: Field, values: Record<string, string>): boolean {
  return !field.showWhen || (values[field.showWhen.key] ?? "") === field.showWhen.value;
}

/**
 * A template's Connect step: its everyday fields, the readiness
 * checklist (`hosts.checkTemplate`), an "Advanced" disclosure with the rest,
 * and Start, which waits until every check is `ok` and every required field
 * is filled. The checklist, and the options of `choice` fields, are asked
 * when the form opens, when the window regains focus, shortly after a field
 * changes, right after a fix, and every 2 s while a check is `busy`; only
 * the latest answer is kept.
 */
function TemplateForm(props: TemplateFormProps) {
  const { template, busy, run, onStarted, onCancel, mode, profile, onSaved } = props;
  const isProfile = mode === "profile";

  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(template.fields.map((f) => [f.key, f.default ?? ""])),
    ...profile?.values,
  }));
  const [profileName, setProfileName] = useState(profile?.name ?? "");
  // A new profile stops when idle after an hour; an edited one keeps its own.
  const [idle, setIdle] = useState(
    profile ? (profile.idleStopMinutes === undefined ? "" : String(profile.idleStopMinutes)) : "60",
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
      ([key, value]) => value !== "" && (current[key] ?? "") === "" && !touchedRef.current.has(key),
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
          } else if (needsCluster(template.id, result)) {
            poll = window.setTimeout(refresh, GUIDE_POLL_MS);
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
      onStarted?.(hostId);
    });

  const save = () =>
    run(async () => {
      const answers = Object.fromEntries(
        Object.entries(values).filter(([key]) => !template.perHost.includes(key)),
      );
      const saved = await window.electronAPI.hostProfiles.save({
        ...(profile ? { id: profile.id } : {}),
        name: profileName.trim(),
        templateId: template.id,
        values: answers,
        idleStopMinutes: idle === "" ? null : Number(idle),
      });
      onSaved?.(saved);
    });

  // A profile never asks for what differs per host.
  const fields = isProfile
    ? template.fields.filter((f) => !template.perHost.includes(f.key))
    : template.fields;
  const shown = fields.filter((f) => isFieldShown(f, values));
  const visible = shown.filter((f) => !f.advanced);
  const advanced = shown.filter((f) => f.advanced);
  const missing = shown.filter((f) => f.required && !(values[f.key] ?? "").trim());
  const checksReady = checks !== null && checks.every((c) => c.state === "ok");
  const verb = isProfile ? "save" : "start";
  const gateHint =
    checks === null
      ? null
      : !checksReady
        ? `Fix the items above to ${verb}.`
        : missing.length > 0
          ? `Fill in ${missing.map((f) => f.label).join(", ")}${
              missing.some((f) => f.advanced) ? " under Advanced" : ""
            } to ${verb}.`
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

  // No cluster yet: the guide stands in for the fields and the checklist, and
  // gives way to them once a context appears (the refresh above sees to it).
  if (checks !== null && choices !== null && needsCluster(template.id, { checks, choices })) {
    return (
      <>
        <ClusterGuide />
        {onCancel && (
          <div>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className={settingsStyles.fieldHint}>{template.description}</div>
      {isProfile && (
        <>
          <SettingField label="Name" hint="How Manor names this profile, e.g. Work cluster.">
            <EmojiInput
              data-testid="profile-name"
              placeholder="e.g. Work cluster"
              value={profileName}
              disabled={busy}
              onChange={(e) => setProfileName(e.target.value)}
            />
          </SettingField>
          <SettingField
            label="Stop when idle for"
            hint="Its hosts stop on their own after this long without activity."
          >
            <ToggleGroup
              value={idle}
              onChange={setIdle}
              options={IDLE_OPTIONS}
              size="sm"
              aria-label="Stop when idle for"
              data-testid="profile-idle"
            />
          </SettingField>
        </>
      )}
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
      {/* Tokens need a saved profile to belong to. */}
      {isProfile && profile && template.id === "kubernetes" && <ProfileSignIn profile={profile} />}
      <Row gap="xs" align="center">
        <Button
          variant="primary"
          size="sm"
          data-testid={isProfile ? "profile-save" : "start-host-submit"}
          disabled={
            busy || missing.length > 0 || !checksReady || (isProfile && profileName.trim() === "")
          }
          onClick={isProfile ? save : start}
        >
          {isProfile ? (busy ? "Saving…" : "Save profile") : busy ? "Starting…" : "Start host"}
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
 * One field's control, by its type. A `choice` field with
 * nothing listed, or a `size` field without options, is typed instead, so
 * no field is ever left unfillable.
 */
function FieldControl(props: FieldControlProps) {
  const { field, value, choices, disabled, onChange } = props;

  const testId = `start-host-field-${field.key}`;

  if ((field.type === "size" || field.type === "segmented") && field.options && field.options.length > 0) {
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

  if (field.type === "multi" && field.options && field.options.length > 0) {
    // The answer is the checked values, comma-separated, in the options' order.
    const checked = value.split(",").map((v) => v.trim());
    const toggle = (optionValue: string, on: boolean) =>
      onChange(
        field
          .options!.map((o) => o.value)
          .filter((v) => (v === optionValue ? on : checked.includes(v)))
          .join(","),
      );
    return (
      <Stack gap="sm" data-testid={testId}>
        {field.options.map((o) => (
          <label key={o.value} className={styles.multiOption}>
            <Checkbox
              size="md"
              checked={checked.includes(o.value)}
              disabled={disabled}
              onCheckedChange={(on) => toggle(o.value, on === true)}
              data-testid={`${testId}-${o.value}`}
            />
            {o.label}
          </label>
        ))}
      </Stack>
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
  const [created, setCreated] = useState<{
    recipeId: string;
    file: string;
  } | null>(null);

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
        A recipe is your own <code>up</code> script, run on this computer: it starts the host and
        prints how to reach it, over ssh or a command like <code>docker exec</code>.{" "}
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
