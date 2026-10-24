import { useJobBridge } from './jobscope';
/**
 * Stage 01, both halves (P4-T2):
 *
 *  - GenerateNew: the "+ tab" — name→slug, image (drop or path), backend
 *    cards from the REAL catalog with their gates in context, the D-009
 *    options form rendered from paramsSchema, one candidate by default. The
 *    button runs exactly the CLI line shown under it.
 *  - Candidates: the editor's Gen stage — per-result cards from the
 *    manifest, More-like-this, and pick with the reproject/colour-match
 *    defaults visible, ending at the canonical-mesh checkpoint.
 *
 * Read-only everywhere except the two verbs this stage exists for.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { CliRun, StudioBridge } from './bridge';
import { slugify, slugProblem } from './slug';
import { adjustArg, resolveOpDefaults, type SchemaField, schemaFields } from './schemaform';
import { t } from './i18n';
import { genArgs, moreLikeArgs, pickArgs, retextureArgs } from './args';
import { Viewport } from './viewport/Viewport';
import { useLandFocus } from './focus';
import { StageRail } from './stagerail';
import { stageStates } from './stages';
import { discoverableModels, generatorSelection } from './genmodels';
import { Inspector, Workbench } from './workbench';
import { JobActivity } from './jobactivity';
import { type ProgressState, readProgress } from './bakeprogress';
import { ImportCharacter } from './import-character';
import { MotionAudition } from './motion-audition';

/** slugProblem returns one of three known sentences — literal per branch so
 * the extractor sees every id (t(variable) is a refused callsite). */
function problemText(p: string): string {
  if (p === 'a name is required') return t('a name is required');
  if (p === 'ids need at least 2 characters') return t('ids need at least 2 characters');
  return t('ids are lowercase letters, digits and dashes');
}

/* ---------------- catalog data ---------------- */

interface CatalogVersion {
  version: string;
  diskBytes: number;
  minVramGb?: number;
  vramProfiles?: { operation: string; params: Record<string, unknown>; minGb: number }[];
  installed: boolean;
  paramsSchema: unknown;
  defaults: Record<string, unknown>;
  operationDefaults?: Record<string, Record<string, unknown>>;
  /** the knobs each operation accepts; the form renders only gen3d's */
  operationParams?: Record<string, string[]>;
  capabilities?: string[];
}

interface CatalogModel {
  id: string;
  kind: string;
  displayName: string;
  license: {
    name: string;
    spdx?: string;
    requiresAcceptance?: boolean;
    excludedTerritories?: string[];
  };
  versions: CatalogVersion[];
}

/* ---------------- backend cards (shared) ---------------- */

function BackendCards({ models, selectedId, onSelect, dimUnselected }: {
  models: CatalogModel[] | null;
  selectedId: string;
  onSelect: (id: string) => void;
  dimUnselected?: boolean;
}) {
  const group = useId();
  const selected = models?.find((m) => m.id === selectedId);
  const installed = selected?.versions.some((v) => v.installed);
  const renderChoices = (choices: CatalogModel[]) => (
    <>
      {choices.map((m) => {
        const v = m.versions.find((x) => x.installed) ?? m.versions[0];
        return (
          <label key={m.id} className={`backend ${selectedId === m.id ? 'on' : ''}`}>
            <input
              type='radio'
              aria-label={m.displayName}
              name={group}
              value={m.id}
              checked={selectedId === m.id}
              onChange={() => onSelect(m.id)}
            />
            <span className='backend-copy'>
              <span className='bname'>{m.displayName.split(' (')[0]}</span>
              <span className='backend-meta'>
                <span>{v?.installed ? t('installed') : t('not installed')}</span>
                {v?.minVramGb !== undefined && (
                  <span>
                    {v.vramProfiles
                      ? t('VRAM depends on configuration')
                      : `≥${v.minVramGb} GiB VRAM`}
                  </span>
                )}
              </span>
            </span>
          </label>
        );
      })}
    </>
  );
  return (
    <div className={`model-choice ${dimUnselected ? 'compareall' : ''}`}>
      <div role='radiogroup' aria-label={t('Backend')} className='backends'>
        {renderChoices(models?.filter((m) => m.id !== 'fixture-gen') ?? [])}
        {models?.some((m) => m.id === 'fixture-gen') && (
          <details className='panel-disclosure dev-models'>
            <summary>{t('Development tools')}</summary>
            {renderChoices(models.filter((m) => m.id === 'fixture-gen'))}
          </details>
        )}
      </div>
      {selected && (
        <>
          {selected.license.requiresAcceptance && !installed && (
            <p className='inote warning'>{t('license acceptance required')}</p>
          )}
          {!!selected.license.excludedTerritories?.length && (
            <p className='inote warning'>
              {t('not available in')}: {selected.license.excludedTerritories.join(', ')}
            </p>
          )}
          <details className='panel-disclosure model-terms'>
            <summary>{t('Model details')}</summary>
            <p>{selected.license.spdx ?? selected.license.name}</p>
          </details>
        </>
      )}
    </div>
  );
}

/** A result's front-view thumb (core output, W5b); absent file = no img. */
function CandThumb({ bridge, path }: { bridge: StudioBridge; path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    bridge.readImage(path).then((s) => live && setSrc(s), () => {});
    return () => {
      live = false;
    };
  }, [bridge, path]);
  if (!src) return null;
  return <img className='candthumb' src={src} alt='' />;
}

/* ---------------- job failure, made legible ---------------- */

export interface JobFailure {
  code: string | null;
  message: string;
}

/** The LAST error event in a finished run's lines - the sentence the user
 * needs, instead of "the log drawer has the verbatim reason" and a hunt. */
export function lastFailure(lines: string[]): JobFailure | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]!);
      if (e.t === 'error') {
        return {
          code: typeof e.code === 'string' ? e.code : null,
          message: String(e.message ?? ''),
        };
      }
    } catch { /* human line */ }
  }
  return null;
}

/** The LAST warn event with this code - for warns a user must not miss. */
export function lastWarnOf(lines: string[], code: string): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]!);
      if (e.t === 'warn' && e.code === code) return String(e.message ?? '');
    } catch { /* human line */ }
  }
  return null;
}

/** Errors whose remedy lives in Manage extensions, so the banner offers the door. */
const MODEL_PROBLEMS = new Set([
  'not-installed',
  'model-missing',
  'backend-unavailable',
  'unknown-model',
  'unknown-version',
  'vram-insufficient',
  'install-conflict',
]);

export function FailureNote({ failure, onOpenModels }: {
  failure: JobFailure;
  onOpenModels?: () => void;
}) {
  // the truncation used to cut messages at their remedy clause (F9); the
  // full sentence is one press away now, and collapses back the same way
  const [expanded, setExpanded] = useState(false);
  const long = failure.message.length > 220;
  const brief = expanded || !long ? failure.message : failure.message.slice(0, 220) + '…';
  return (
    <span className='mv-exit mono' role='status'>
      {t('failed')}: {brief || t('the log drawer has the verbatim reason')}
      {long && (
        <>
          {' '}
          <button
            type='button'
            className='linkish'
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? t('less') : t('show all')}
          </button>
        </>
      )}
      {onOpenModels && failure.code !== null && MODEL_PROBLEMS.has(failure.code) && (
        <>
          {' '}
          <button type='button' className='linkish' onClick={onOpenModels}>
            {t('Manage extensions…')}
          </button>
        </>
      )}
    </span>
  );
}

function useGenBackends(bridge: StudioBridge, open: boolean, catalogEpoch = 0) {
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    bridge.runCli(['models', 'list', '--json']).then((r) => {
      if (!live) return;
      if (r.exitCode !== 0 || r.lines.length === 0) {
        setError(t('could not read the catalog — the log drawer has the verbatim reason'));
        return;
      }
      try {
        const doc = JSON.parse(r.lines.at(-1)!);
        const rows = (doc.models ?? []) as CatalogModel[];
        setModels(discoverableModels(
          rows.filter((m) =>
            m.kind === 'gen3d' ||
            m.versions.some((v) => v.capabilities?.includes('gen3d'))
          ),
          import.meta.env.DEV,
        ));
      } catch {
        setError(t('catalog output was not JSON'));
      }
    });
    return () => {
      live = false;
    };
  }, [bridge, open, catalogEpoch]);
  return { models, error };
}

/* ---------------- the options form ---------------- */

function optionLabel(key: string): string {
  switch (key) {
    case 'seed':
      return t('Seed');
    case 'steps':
      return t('Steps');
    case 'guidanceStrength':
      return t('Guidance');
    case 'decimationTarget':
      return t('Polygon budget');
    case 'textureSize':
      return t('Texture size');
    case 'lowVram':
      return t('Low VRAM mode');
    case 'tris':
      return t('Triangle budget');
    case 'fov':
      return t('Field of view');
    case 'resolution':
      return t('Resolution');
    case 'pipelineType':
      return t('Pipeline');
    case 'textureGuidance':
      return t('Texture guidance');
    case 'textureGuidanceRescale':
      return t('Texture guidance rescale');
    case 'textureRetries':
      return t('Texture retries');
    default:
      return key;
  }
}

function OptionsForm({ fields, values, onChange }: {
  fields: SchemaField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className='optform'>
      {fields.map((f) => {
        const v = values[f.key] ?? f.defaultValue;
        const id = `opt-${f.key}`;
        return (
          <div className='optrow' key={f.key}>
            <label htmlFor={id} className='optkey' title={f.description}>
              {optionLabel(f.key)}
            </label>
            {f.kind === 'boolean' && (
              <input
                id={id}
                type='checkbox'
                checked={v === true}
                onChange={(e) => onChange(f.key, e.target.checked)}
              />
            )}
            {(f.kind === 'number' || f.kind === 'integer') && (
              <input
                id={id}
                className='optnum mono'
                type='number'
                value={v === undefined ? '' : String(v)}
                min={f.min}
                max={f.max}
                step={f.kind === 'integer' ? 1 : 'any'}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange(f.key, raw === '' ? undefined : Number(raw));
                }}
              />
            )}
            {f.kind === 'enum' && (
              <select
                id={id}
                className='optnum mono'
                value={String(v ?? '')}
                onChange={(e) => onChange(f.key, e.target.value)}
              >
                {f.enumValues!.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
              </select>
            )}
            {f.kind === 'string' && (
              <input
                id={id}
                className='optnum mono'
                type='text'
                value={String(v ?? '')}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            )}
            {f.kind === 'unsupported' && <span className='mono optnum'>{String(v)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- CLI twin ---------------- */

export function CliTwin({ args }: { args: string[] }) {
  const [copied, setCopied] = useState(false);
  const line = `spritebook ${args.join(' ')}`;
  return (
    <div className='clitwin mono'>
      {
        /* static text, NOT a tab stop: the walkthrough counted it as a dead
          focus position before every Copy button on five surfaces */
      }
      <span className='clitwincmd' title={line} role='note' aria-label={t('CLI twin')} tabIndex={0}>
        $ {line}
      </span>
      <button
        type='button'
        className='btn mbtn'
        onClick={() => {
          navigator.clipboard.writeText(line).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }, () => {});
        }}
      >
        {copied ? t('Copied') : t('Copy')}
      </button>
    </div>
  );
}

/* ---------------- GenerateNew (the + tab) ---------------- */

export function GenerateNew(
  { bridge: baseBridge, projectsRoot, onCreated, onBack, onOpenModels, catalogEpoch, vramGb }: {
    bridge: StudioBridge;
    projectsRoot: string;
    /** called with the new CHARACTER ID after gen exits 0 - the App re-reads
     * the list and resolves the workspace dir in the shell's own notation */
    onCreated: (characterId: string) => void;
    onBack: () => void;
    onOpenModels: () => void;
    /** bumped when Manage extensions closes - the backend cards re-read the catalog */
    catalogEpoch?: number;
    /** the health exam's measured VRAM (F3) - null until an exam has run */
    vramGb?: number | null;
  },
) {
  const { bridge, busy: jobBusy, cancel } = useJobBridge(baseBridge, projectsRoot);
  const [name, setName] = useState('');
  const [importing, setImporting] = useState(false);
  const [imagePath, setImagePath] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const { models, error: catalogError } = useGenBackends(bridge, true, catalogEpoch);
  const [requestedModel, setModelId] = useState('');
  const modelId = generatorSelection(models, requestedModel);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [run, setRun] = useState<{ running: boolean; progress: ProgressState | null } | null>(null);
  const [failure, setFailure] = useState<JobFailure | null>(null);
  const [canceled, setCanceled] = useState(false);
  useLandFocus(canceled, '.newcharacter .job-canceled');
  useLandFocus(failure !== null, '.newcharacter .mv-exit');
  // Start with one inference; additional candidates are an explicit resource budget.
  const [count, setCount] = useState(1);
  const [compare, setCompare] = useState(false);
  // the size every later stage believes (D-012): bake frames at
  // pixelsPerMeter, so a character left at the backend's unit-box scale bakes
  // ~30 px tall - wave 4's fifth finding. Default 1.7 m; emptying the field
  // keeps the backend scale and the core warn below says what that means.
  const [heightM, setHeightM] = useState('1.7');
  const [scaleWarn, setScaleWarn] = useState<string | null>(null);

  const slug = slugify(name);
  const problem = slugProblem(slug);

  useEffect(() => {
    return bridge.onFileDrop?.((paths) => {
      const img = paths.find((p) => /\.(png|jpe?g|webp)$/i.test(p));
      if (img) setImagePath(img);
    });
  }, [bridge]);

  useEffect(() => {
    setPreview(null);
    setImageError(false);
    setImageLoading(imagePath.length > 0);
    if (!imagePath) return;
    let live = true;
    bridge.readImage(imagePath).then((src) => {
      if (!live) return;
      setPreview(src);
      setImageError(!src);
      setImageLoading(false);
    }, () => {
      if (!live) return;
      setImageError(true);
      setImageLoading(false);
    });
    return () => {
      live = false;
    };
  }, [bridge, imagePath]);

  const model = models?.find((m) => m.id === modelId) ?? null;
  const version = model?.versions.find((v) => v.installed) ?? model?.versions[0] ?? null;
  const installedGen = useMemo(
    () => (models ?? []).filter((m) => m.versions.some((v) => v.installed)),
    [models],
  );
  const resolved = useMemo(
    () => version ? resolveOpDefaults(version.defaults, version.operationDefaults, 'gen3d') : {},
    [version],
  );
  const fields = useMemo(
    () =>
      (version ? schemaFields(version.paramsSchema, resolved, version.operationParams?.gen3d) : [])
        // the count has its own control above the form now
        .filter((f) => f.key !== 'candidates'),
    [version, resolved],
  );

  // Only suggest the resident mode when the catalog has a matching measured claim.
  useEffect(() => {
    const resident = version?.vramProfiles?.find((p) =>
      p.operation === 'gen3d' &&
      p.params.lowVram === false && Object.entries(p.params).every(([k, v]) =>
        k === 'lowVram' || resolved[k] === v
      )
    );
    if (resident && (vramGb ?? 0) >= resident.minGb && resolved['lowVram'] === true) {
      setValues((cur) => ('lowVram' in cur ? cur : { ...cur, lowVram: false }));
    }
  }, [vramGb, resolved, version]);

  const workspace = `${projectsRoot}/${slug || '<id>'}`;
  const heightVal = heightM.trim() === '' ? undefined : Number(heightM);
  const heightBad = heightVal !== undefined && !(heightVal > 0 && heightVal < 10);
  const args = useMemo(() => {
    const rest = { ...values };
    delete rest['seed'];
    delete rest['candidates'];
    const seed = values['seed'];
    return genArgs(workspace, {
      characterId: slug || '<id>',
      imagePath,
      modelId,
      adjust: adjustArg(rest, resolved),
      ...(heightVal !== undefined && !heightBad ? { heightM: heightVal } : {}),
      ...(seed !== undefined && seed !== resolved['seed'] ? { seed: Number(seed) } : {}),
      ...(count !== 1 ? { candidates: count } : {}),
    });
  }, [workspace, slug, imagePath, modelId, values, resolved, count, heightVal, heightBad]);

  // HALLWAY TEST finding: the button sat disabled and said nothing, so a
  // first-timer typed a name and had to GUESS that an image was also
  // required. Every blocker now names itself, in the order they must be fixed.
  const blocker = problem !== null
    ? (name.length === 0 ? t('a name is required') : problemText(problem))
    : imagePath.length === 0
    ? t('a source image is required')
    : compare && count < installedGen.length
    ? t('Choose at least one candidate per compared backend.')
    : version === null
    ? t('pick a backend')
    : !version.installed
    ? t('that backend is not installed yet')
    : heightBad
    ? t('height must be metres between 0 and 10, or empty to keep the backend scale')
    : null;
  const ready = blocker === null && run?.running !== true;

  const generate = useCallback(async () => {
    if (!ready) return; // the button stays focusable while running (aria-busy)
    setFailure(null);
    setCanceled(false);
    setScaleWarn(null);
    setRun({ running: true, progress: null });
    const onLine = (line: string) => {
      const progress = readProgress(line);
      if (progress) setRun({ running: true, progress });
    };
    // compare mode: one job per installed backend, the count SPLIT across
    // them (first jobs take the remainder), each at its own defaults. The
    // first job creates the workspace; the rest append results - and the
    // VRAM lease already queues the GPU ones, so sequential await is honest.
    const jobs = compare && installedGen.length > 1
      ? installedGen.map((m, i) => {
        const base = Math.floor(count / installedGen.length);
        const n = i < count % installedGen.length ? base + 1 : base;
        return genArgs(workspace, {
          characterId: slug || '<id>',
          imagePath,
          modelId: m.id,
          ...(heightVal !== undefined && !heightBad ? { heightM: heightVal } : {}),
          ...(Math.max(1, n) !== 1 ? { candidates: Math.max(1, n) } : {}),
        });
      })
      : [args];
    let created = false;
    let fail: JobFailure | null = null;
    let warn: string | null = null;
    for (const jobArgs of jobs) {
      const r: CliRun = await bridge.runCli([...jobArgs, '--json'], onLine);
      if (r.exitCode === 130) {
        setCanceled(true);
        break;
      }
      if (r.exitCode === 0) created = true;
      else fail = lastFailure(r.lines) ?? { code: null, message: '' };
      // the scale warn is the one a user must SEE before they build five
      // stages on a unit-box character (wave 4's fifth finding)
      warn = lastWarnOf(r.lines, 'scale-undeclared') ?? warn;
    }
    setRun({ running: false, progress: null });
    if (fail) setFailure(fail);
    if (warn) setScaleWarn(warn);
    // any successful job made results worth looking at - navigate even when
    // a sibling backend failed; the banner travels via the drawer either way
    if (created) onCreated(slug);
  }, [
    bridge,
    args,
    slug,
    onCreated,
    ready,
    compare,
    installedGen,
    count,
    workspace,
    imagePath,
    heightVal,
    heightBad,
  ]);

  if (importing) {
    return (
      <ImportCharacter
        bridge={baseBridge}
        projectsRoot={projectsRoot}
        onCreated={onCreated}
        onBack={() => setImporting(false)}
      />
    );
  }

  return (
    <div className='newcharacter'>
      <StageRail stages={stageStates({})} active='gen' onSelect={() => {}} />
      <Workbench
        title={name.trim() || t('New character')}
        actions={jobBusy && (
          <button type='button' className='btn' onClick={cancel} title='CLI: Ctrl+C'>
            {t('Cancel job')}
          </button>
        )}
      >
        <div className='gennew workbench-stage'>
          <section className='asset-workspace source-workspace' aria-label={t('Source image')}>
            <div className='panel-heading'>
              <h2>{t('Source image')}</h2>
              <button
                type='button'
                className='linkish'
                disabled={run?.running}
                onClick={() => setImporting(true)}
              >
                {t('Use a mesh or offline example')}
              </button>
              <button type='button' className='linkish' onClick={onBack}>
                {t('Back to gallery')}
              </button>
            </div>
            <div className='source-well'>
              {preview
                ? (
                  <img
                    src={preview}
                    alt={t('Source image')}
                    onError={() => {
                      setPreview(null);
                      setImageError(true);
                    }}
                  />
                )
                : (
                  <div className='well-empty'>
                    <h2>
                      {imageLoading
                        ? t('Loading source image…')
                        : t('Start with a character reference')}
                    </h2>
                    <p role='status'>
                      {imageError
                        ? t('Source preview unavailable. Check the image path.')
                        : t('drop an image anywhere, or paste a path')}
                    </p>
                  </div>
                )}
            </div>
            <div className='source-path field'>
              <p className='inote'>
                {t(
                  'For animation, separate hands from the body and show the feet. Loose or layered clothing may need preparation. More polygons do not guarantee better motion.',
                )}
              </p>
              <label htmlFor='gimage'>{t('Source image')}</label>
              <input
                id='gimage'
                disabled={run?.running}
                className='rootinput'
                value={imagePath}
                onChange={(e) => setImagePath(e.target.value)}
                placeholder={t('drop an image anywhere, or paste a path')}
                spellCheck={false}
              />
            </div>
            {run?.running && <JobActivity progress={run.progress} verb='gen' />}
            {failure && <FailureNote failure={failure} onOpenModels={onOpenModels} />}
            {canceled && <p className='inote job-canceled' role='status'>{t('Job canceled')}</p>}
            {scaleWarn && <span className='mv-warn mono' role='status'>{scaleWarn}</span>}
          </section>
          <Inspector>
            <div
              className='settings-fields'
              tabIndex={0}
              role='region'
              aria-label={t('Generation settings')}
            >
              <fieldset disabled={run?.running} className='settings-group'>
                <section className='control-section'>
                  <h2>{t('Character')}</h2>
                  <div className='field'>
                    <label htmlFor='gname'>{t('Name')}</label>
                    <input
                      id='gname'
                      className='rootinput'
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      spellCheck={false}
                      autoComplete='off'
                    />
                    <span className={`slugpreview mono ${problem && name ? 'bad' : ''}`}>
                      {t('id')}: {slug || '—'}
                      {problem && name.length > 0 ? ` · ${problemText(problem)}` : ''}
                    </span>
                  </div>
                  <div className='field'>
                    <label htmlFor='gheight'>{t('Height (m)')}</label>
                    <input
                      id='gheight'
                      className='optnum mono'
                      value={heightM}
                      onChange={(e) => setHeightM(e.target.value)}
                      inputMode='decimal'
                      spellCheck={false}
                      aria-describedby='height-note'
                    />
                    <span id='height-note' className='inote'>
                      {t('the size every stage believes — sprites frame at pixels-per-metre')}
                    </span>
                  </div>
                </section>
                <section className='control-section'>
                  <h2>{t('Backend')}</h2>
                  {catalogError && <div className='mdl-error mono'>{catalogError}</div>}
                  {!models && !catalogError && (
                    <p className='inote' role='status'>{t('Loading models…')}</p>
                  )}
                  <BackendCards
                    models={models}
                    selectedId={modelId}
                    onSelect={(id) => {
                      setModelId(id);
                      setValues({});
                    }}
                    dimUnselected={compare && installedGen.length > 1}
                  />
                  {model && version && !version.installed && (
                    <p className='inote'>
                      {t('this backend is not installed')} —{' '}
                      <button type='button' className='linkish' onClick={onOpenModels}>
                        {t('Manage extensions…')}
                      </button>
                    </p>
                  )}
                </section>
                <section className='control-section'>
                  <h2>{t('Generation')}</h2>
                  <div className='field'>
                    <label htmlFor='gencount'>{t('Candidates')}</label>
                    <input
                      id='gencount'
                      className='optnum mono'
                      type='number'
                      min={1}
                      max={8}
                      value={count}
                      onChange={(e) =>
                        setCount(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
                    />
                    <span className='inote'>
                      {t('one job - the model loads once; candidate 2 runs at seed + 1000')}
                    </span>
                  </div>
                  {fields.some((f) => f.key === 'decimationTarget') && (
                    <div className='field'>
                      <span className='optkey'>{t('Effort')}</span>
                      <span
                        className='m-seg'
                        role='group'
                        aria-label={t('Effort (polygon budget)')}
                      >
                        {EFFORT_PRESETS.map((p) => (
                          <button
                            key={p.key}
                            type='button'
                            className='btn mbtn'
                            aria-pressed={(values['decimationTarget'] ??
                              resolved['decimationTarget']) === p.decimationTarget}
                            onClick={() =>
                              setValues((cur) => ({
                                ...cur,
                                decimationTarget: p.decimationTarget,
                              }))}
                          >
                            {p.label()}
                          </button>
                        ))}
                      </span>
                    </div>
                  )}
                  <OptionsForm
                    fields={fields.filter((f) =>
                      MORE_FIELDS.has(f.key) && f.key !== 'decimationTarget'
                    )}
                    values={values}
                    onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
                  />
                  <details className='panel-disclosure'>
                    <summary>{t('Advanced options')}</summary>
                    <p className='inote'>{t('defaults are the catalog’s — only changes travel')}</p>
                    <OptionsForm
                      fields={fields.filter((f) =>
                        !MORE_FIELDS.has(f.key) || f.key === 'decimationTarget'
                      )}
                      values={values}
                      onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
                    />
                    {values['lowVram'] === false && resolved['lowVram'] === true && (
                      <p className='inote'>
                        {t('lowVram is off — the health exam found')} {vramGb} GiB
                      </p>
                    )}
                    {installedGen.length > 1 && (
                      <label className='check-field'>
                        <input
                          type='checkbox'
                          checked={compare}
                          onChange={(e) => {
                            setCompare(e.target.checked);
                            if (e.target.checked) setCount((n) => Math.max(n, installedGen.length));
                          }}
                        />
                        {t(
                          'Compare backends — one job per installed backend, the count split across them',
                        )}
                      </label>
                    )}
                    {compare && (
                      <p className='inote'>
                        {t(
                          'each backend runs its own defaults; the cards below label every result',
                        )}
                      </p>
                    )}
                  </details>
                </section>
              </fieldset>
            </div>
            <section className='control-section action-section'>
              <button
                type='button'
                className='btn primary genbtn'
                disabled={blocker !== null}
                aria-busy={run?.running === true}
                onClick={generate}
              >
                {run?.running ? t('Generating…') : t('Generate model')}
              </button>
              {!ready && blocker !== null && <p className='blocker mono' role='status'>{blocker}
              </p>}
              <CliTwin args={args} />
              {bridge.name === 'browser-demo' && (
                <p className='inote'>{t('browser preview: generate needs the desktop shell')}</p>
              )}
            </section>
          </Inspector>
        </div>
      </Workbench>
    </div>
  );
}

/* ---------------- Candidates (the editor's Gen stage) ---------------- */

interface ResultEntry {
  id: string;
  seed: number;
  discarded?: boolean;
  backend?: { modelId?: string; version?: string };
  output?: { tris?: number; textureRes?: number };
  wallTimeS?: number;
  /** the recipe this result was made with — re-run verbatim by more-like */
  params?: { candidates?: number };
}

/** Display the original reference; core's sourceImagePath prefers the prepared cutout. */
export function storedSourcePath(dir: string, m: Record<string, unknown>): string | null {
  const src = m.source as { sha256?: string; originalFilename?: string } | undefined;
  if (!src?.sha256 || !src.originalFilename) return null;
  const dot = src.originalFilename.lastIndexOf('.');
  const ext = dot > 0 ? src.originalFilename.slice(dot) : '';
  return `${dir}/source/${src.sha256}${ext}`;
}

export function Candidates({ bridge, dir, manifest, onChanged, onOpenModels, catalogEpoch }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
  onOpenModels: () => void;
  /** bumped when Manage extensions closes - the panel's cards re-read the catalog */
  catalogEpoch?: number;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const characterId = typeof m.id === 'string' ? m.id : '';
  const gen = (m.generation ?? {}) as Record<string, unknown>;
  const results = (Array.isArray(gen.results) ? gen.results : []) as ResultEntry[];
  const picked = typeof gen.pickedResultId === 'string' ? gen.pickedResultId : undefined;
  const canonical = m.canonicalMesh !== undefined && m.canonicalMesh !== null;
  const imported = (m.source as { kind?: string } | undefined)?.kind === 'mesh';

  const [inspecting, setInspecting] = useState<string | null>(() =>
    canonical ? null : results[0]?.id ?? null
  );
  const [reproject, setReproject] = useState(false);
  const [audition, setAudition] = useState<string | null>(null);
  const [motionPath, setMotionPath] = useState<string | null>(null);
  const [colorMatch, setColorMatch] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [verb, setVerb] = useState('gen');
  const [canceled, setCanceled] = useState(false);
  useLandFocus(canceled, '.cands .job-canceled');
  const [failures, setFailures] = useState<Record<string, JobFailure>>({});

  // When the pick lands the checkpoint banner appears - put keyboard focus on
  // it, because the button that was focused goes disabled and the user would
  // otherwise be dropped to <body> (walkthrough finding).
  useLandFocus(canonical, '.checkpoint');

  const pickFor = useCallback(
    (id: string) => pickArgs(dir, id, { reproject, colorMatch }),
    [dir, reproject, colorMatch],
  );

  const runFor = useCallback(async (key: string, cardId: string, cliArgs: string[]) => {
    if (busy !== null) return;
    setBusy(key);
    setProgress(null);
    setCanceled(false);
    setVerb(cliArgs.includes('--audition') ? 'motion-audition' : cliArgs[0] ?? 'gen');
    setFailures({});
    const r = await bridge.runCli([...cliArgs, '--json'], (line) => {
      const next = readProgress(line);
      if (next) setProgress(next);
    });
    setBusy(null);
    if (r.exitCode === 0) {
      if (cliArgs[0] === 'pick') setInspecting(null);
      if (!cliArgs.includes('--audition')) onChanged();
    } else if (r.exitCode === 130) {
      setCanceled(true);
    } else {
      setFailures({ [cardId]: lastFailure(r.lines) ?? { code: null, message: '' } });
    }
    return r.exitCode;
  }, [bridge, onChanged, busy]);

  const doPick = useCallback(
    (id: string) => runFor(`pick:${id}`, id, pickFor(id)),
    [runFor, pickFor],
  );
  // gen ALWAYS requires --character (the field test's first error)
  const moreLike = useCallback(
    (id: string) => runFor(`more:${id}`, id, moreLikeArgs(dir, characterId, id)),
    [runFor, dir, characterId],
  );
  // a NEW texture on this result's mesh - core appends a new result card
  const retexture = useCallback(
    (id: string) => runFor(`retex:${id}`, id, retextureArgs(dir, id)),
    [runFor, dir],
  );

  return (
    <div className='cands workbench-stage'>
      <div className='asset-workspace'>
        {canonical && (
          <div className='checkpoint'>
            <span className='hud'>{t('canonical mesh saved')}</span>
            <span className='mono'>
              {picked ? `${t('pick')} ${picked}` : ''} · {t('stages 02–06 are unlocked')}
            </span>
          </div>
        )}
        {busy && <JobActivity key={busy} progress={progress} verb={verb} />}
        {canceled && <p className='inote job-canceled' role='status'>{t('Job canceled')}</p>}
        {(inspecting !== null || canonical) && (
          <div className='candvp'>
            <div className='candvplabel mono' role='status'>
              {t('inspecting')}: {inspecting ?? t('canonical mesh')}
            </div>
            <Viewport
              bridge={bridge}
              meshPath={motionPath ?? (inspecting !== null
                ? `${dir}/results/${inspecting}/model.glb`
                : `${dir}/canonical/model.glb`)}
              contentKey={String(
                (m.canonicalMesh as { gltfSha256?: string } | undefined)?.gltfSha256 ?? '',
              )}
            />
          </div>
        )}
        {!canonical && inspecting === null && (
          <div className='well-empty model-empty'>
            <h2>{t('Model preview')}</h2>
            <p>{t('Inspect a candidate to compare it here.')}</p>
          </div>
        )}
        {!imported && (
          <section className='candidate-shelf' aria-label={t('Candidates')}>
            <div className='panel-heading'>
              <h2>{t('Candidates')}</h2>
              <span className='inote'>{results.length}</span>
            </div>
            <div className='candgrid'>
              {results.map((r) => (
                <div
                  key={r.id}
                  className={`cand ${picked === r.id ? 'picked' : ''} ${
                    inspecting === r.id ? 'inspecting' : ''
                  }`}
                >
                  <div className='candhead'>
                    <span className='mono candid'>{r.id}</span>
                    {picked === r.id && <span className='mbadge ok'>{t('picked')}</span>}
                    {inspecting === r.id && <span className='mbadge'>{t('inspecting')}</span>}
                    {r.discarded && <span className='mbadge'>{t('discarded')}</span>}
                  </div>
                  <CandThumb bridge={bridge} path={`${dir}/results/${r.id}/thumb.png`} />
                  <div className='candmeta mono'>
                    {t('seed')} {r.seed}
                    {r.backend?.modelId ? ` · ${r.backend.modelId}` : ''}
                    {r.output?.tris !== undefined
                      ? ` · ${(r.output.tris / 1000).toFixed(0)}k tris`
                      : ''}
                    {r.output?.textureRes !== undefined ? ` · ${r.output.textureRes}px` : ''}
                    {r.wallTimeS !== undefined ? ` · ${Math.round(r.wallTimeS)}s` : ''}
                  </div>
                  <div className='candacts'>
                    <button
                      type='button'
                      className='btn mbtn'
                      aria-pressed={inspecting === r.id}
                      onClick={() => {
                        setMotionPath(null);
                        setInspecting(inspecting === r.id ? null : r.id);
                      }}
                    >
                      {t('Inspect')}
                    </button>
                    <button
                      type='button'
                      className='btn mbtn'
                      disabled={busy !== null || r.discarded}
                      onClick={() => {
                        setAudition(r.id);
                        setMotionPath(null);
                        setInspecting(r.id);
                      }}
                    >
                      {t('Review motion')}
                    </button>
                    <button
                      type='button'
                      className='btn mbtn primaryish'
                      disabled={busy !== null && busy !== `pick:${r.id}`}
                      aria-busy={busy === `pick:${r.id}`}
                      onClick={() => doPick(r.id)}
                    >
                      {t('Save as canonical mesh')}
                    </button>
                  </div>
                  <details className='candidate-actions'>
                    <summary>{t('More actions')}</summary>
                    <div className='candacts'>
                      <button
                        type='button'
                        className='btn mbtn'
                        disabled={busy !== null && busy !== `more:${r.id}`}
                        aria-busy={busy === `more:${r.id}`}
                        onClick={() => moreLike(r.id)}
                        title={t('re-runs this result’s recipe with a new seed')}
                      >
                        {busy === `more:${r.id}` ? t('Working…') : (
                          // more-like reproduces the RECIPE, so a candidate ladder
                          // yields that many again — the parity run found this
                          (r.params?.candidates ?? 1) > 1
                            ? `${t('More like this')} (×${r.params!.candidates})`
                            : t('More like this')
                        )}
                      </button>
                      <button
                        type='button'
                        className='btn mbtn'
                        disabled={busy !== null && busy !== `retex:${r.id}`}
                        aria-busy={busy === `retex:${r.id}`}
                        onClick={() => retexture(r.id)}
                        title={t('keeps this mesh, paints a new texture — a new card appears')}
                      >
                        {t('Re-texture')}
                      </button>
                    </div>
                    <CliTwin args={pickFor(r.id)} />
                  </details>
                  {failures[r.id] && (
                    <FailureNote
                      failure={failures[r.id]!}
                      onOpenModels={onOpenModels}
                    />
                  )}
                </div>
              ))}
            </div>
            {results.length === 0 && <p className='inote'>{t('nothing generated')}</p>}
          </section>
        )}
      </div>
      <Inspector>
        {audition && (
          <section className='control-section'>
            <h2>{t('Motion review')}: {audition}</h2>
            <MotionAudition
              bridge={bridge}
              dir={dir}
              sourceKey={audition}
              resultId={audition}
              busy={busy !== null}
              running={busy === `audition:${audition}`}
              run={async (args) => await runFor(`audition:${audition}`, audition, args) ?? null}
              onPlay={(path) => setMotionPath(path)}
            />
          </section>
        )}
        {imported
          ? (
            <section className='control-section'>
              <h2>{t('Imported character')}</h2>
              <p className='inote'>
                {t(
                  'Source materials and authored skinning are preserved. Continue to Rig to review movement.',
                )}
              </p>
            </section>
          )
          : (
            <GenerateMore
              bridge={bridge}
              dir={dir}
              m={m}
              characterId={characterId}
              results={results}
              busy={busy}
              runFor={runFor}
              failure={failures['genmore'] ?? null}
              onOpenModels={onOpenModels}
              catalogEpoch={catalogEpoch}
            />
          )}
        {results.length > 0 && (
          <details className='control-section pickopts panel-disclosure'>
            <summary>{t('Canonical mesh options')}</summary>
            <span>{t('Optional texture changes on save:')}</span>
            <label>
              <input
                type='checkbox'
                checked={reproject}
                onChange={(e) => setReproject(e.target.checked)}
              />
              {t('reproject source detail')}
            </label>
            <label>
              <input
                type='checkbox'
                checked={colorMatch}
                onChange={(e) => setColorMatch(e.target.checked)}
              />
              {t('match source colours')}
            </label>
            <CliTwin args={pickFor(inspecting ?? picked ?? results[0]?.id ?? 'rN')} />
          </details>
        )}
      </Inspector>
    </div>
  );
}

/* ---------------- Generate more (the full-control panel) ---------------- */

/** Effort as a polygon budget. The presets are UI shorthand over the raw
 * field, which stays visible and editable - medium matches what the shipped
 * defaults have produced in practice (~200k tris on the reference images). */
const EFFORT_PRESETS = [
  { key: 'low', label: () => t('Low'), decimationTarget: 50_000 },
  { key: 'medium', label: () => t('Medium'), decimationTarget: 200_000 },
  { key: 'high', label: () => t('High'), decimationTarget: 800_000 },
] as const;

/** The curated knobs; everything else keeps its catalog default. */
const MORE_FIELDS = new Set(['guidanceStrength', 'decimationTarget', 'tris', 'steps', 'seed']);

function GenerateMore(
  { bridge, dir, m, characterId, results, busy, runFor, failure, onOpenModels, catalogEpoch }: {
    bridge: StudioBridge;
    dir: string;
    m: Record<string, unknown>;
    characterId: string;
    results: ResultEntry[];
    busy: string | null;
    runFor: (key: string, cardId: string, cliArgs: string[]) => Promise<number | null | undefined>;
    failure: JobFailure | null;
    onOpenModels: () => void;
    catalogEpoch?: number;
  },
) {
  const { models, error: catalogError } = useGenBackends(bridge, true, catalogEpoch);
  // default to the backend that made the newest result - "more of what I
  // just got" is the likeliest intent
  const [requestedModel, setModelId] = useState(() => results.at(-1)?.backend?.modelId ?? '');
  const modelId = generatorSelection(models, requestedModel);
  const [count, setCount] = useState(2);
  const [values, setValues] = useState<Record<string, unknown>>({});
  // same default as the + tab (D-012): a result generated without a height
  // keeps the backend's unit-box scale and bakes ~30 px tall
  const [heightM, setHeightM] = useState('1.7');

  const model = models?.find((x) => x.id === modelId) ?? null;
  const version = model?.versions.find((v) => v.installed) ?? model?.versions[0] ?? null;
  const resolved = useMemo(
    () => version ? resolveOpDefaults(version.defaults, version.operationDefaults, 'gen3d') : {},
    [version],
  );
  const fields = useMemo(
    () =>
      (version ? schemaFields(version.paramsSchema, resolved, version.operationParams?.gen3d) : [])
        .filter((f) => MORE_FIELDS.has(f.key)),
    [version, resolved],
  );
  const hasDecimation = fields.some((f) => f.key === 'decimationTarget');
  const source = storedSourcePath(dir, m);

  const heightVal = heightM.trim() === '' ? undefined : Number(heightM);
  const heightOk = heightVal === undefined || (heightVal > 0 && heightVal < 10);
  const args = useMemo(() => {
    const rest = { ...values };
    delete rest['seed'];
    const seed = values['seed'];
    return genArgs(dir, {
      characterId,
      imagePath: source ?? '<source>',
      modelId,
      adjust: adjustArg(rest, resolved),
      ...(heightVal !== undefined && heightOk ? { heightM: heightVal } : {}),
      ...(seed !== undefined && seed !== resolved['seed'] ? { seed: Number(seed) } : {}),
      ...(count !== 1 ? { candidates: count } : {}),
    });
  }, [dir, characterId, source, modelId, values, resolved, count, heightVal, heightOk]);

  const ready = source !== null && version?.installed === true && busy === null && heightOk;

  return (
    <div className='generation-controls'>
      <section className='control-section gmore'>
        <div className='gensechead'>
          <h2>{t('Backend')}</h2>
        </div>
        {catalogError && <div className='mdl-error mono'>{catalogError}</div>}
        {!models && !catalogError && <div className='inote'>…</div>}
        <BackendCards
          models={models}
          selectedId={modelId}
          onSelect={(id) => {
            setModelId(id);
            setValues({});
          }}
        />
        <div className='settings-pair'>
          <div className='field'>
            <label htmlFor='gmcount'>{t('Candidates')}</label>
            <input
              id='gmcount'
              className='optnum mono'
              type='number'
              min={1}
              max={8}
              value={count}
              onChange={(e) => setCount(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
            />
          </div>
          <div className='field'>
            <label htmlFor='gmheight'>{t('Height (m)')}</label>
            <input
              id='gmheight'
              className='optnum mono'
              value={heightM}
              onChange={(e) => setHeightM(e.target.value)}
              inputMode='decimal'
              spellCheck={false}
            />
          </div>
          {hasDecimation && (
            <div className='field effort-field'>
              <span className='optkey mono'>{t('effort')}</span>
              <span className='m-seg' role='group' aria-label={t('Effort (polygon budget)')}>
                {EFFORT_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type='button'
                    className='btn mbtn'
                    aria-pressed={(values['decimationTarget'] ?? resolved['decimationTarget']) ===
                      p.decimationTarget}
                    onClick={() =>
                      setValues((cur) => ({ ...cur, decimationTarget: p.decimationTarget }))}
                  >
                    {p.label()}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
        <OptionsForm
          fields={fields.filter((f) => f.key !== 'decimationTarget' && f.key !== 'tris')}
          values={values}
          onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
        />
        {fields.some((f) => f.key === 'decimationTarget' || f.key === 'tris') && (
          <details className='panel-disclosure'>
            <summary>{t('Advanced options')}</summary>
            <OptionsForm
              fields={fields.filter((f) => f.key === 'decimationTarget' || f.key === 'tris')}
              values={values}
              onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
            />
          </details>
        )}
      </section>
      <section className='control-section action-section'>
        <div className='genrow'>
          <button
            type='button'
            className='btn primary'
            disabled={!ready && busy === null}
            aria-busy={busy === 'genmore'}
            onClick={() => {
              if (ready) runFor('genmore', 'genmore', args);
            }}
          >
            {busy === 'genmore' ? t('Generating…') : `${t('Generate')} ${count}`}
          </button>
          {source === null && (
            <span className='inote'>{t('this workspace records no source image')}</span>
          )}
          {version !== null && !version.installed && (
            <span className='inote'>
              {t('this backend is not installed')} —{' '}
              <button type='button' className='linkish' onClick={onOpenModels}>
                {t('Manage extensions…')}
              </button>
            </span>
          )}
        </div>
        {failure && <FailureNote failure={failure} onOpenModels={onOpenModels} />}
        <CliTwin args={args} />
      </section>
    </div>
  );
}
