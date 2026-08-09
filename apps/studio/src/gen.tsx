/**
 * Stage 01, both halves (P4-T2):
 *
 *  - GenerateNew: the "+ tab" — name→slug, image (drop or path), backend
 *    cards from the REAL catalog with their gates in context, the D-009
 *    options form rendered from paramsSchema, generate-one default. The
 *    button runs exactly the CLI line shown under it.
 *  - Candidates: the editor's Gen stage — per-result cards from the
 *    manifest, More-like-this, and pick with the reproject/colour-match
 *    defaults visible, ending at the canonical-mesh checkpoint.
 *
 * Read-only everywhere except the two verbs this stage exists for.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CliRun, StudioBridge } from './bridge';
import { slugify, slugProblem } from './slug';
import { adjustArg, resolveOpDefaults, type SchemaField, schemaFields } from './schemaform';
import { t } from './i18n';
import { genArgs, moreLikeArgs, pickArgs, retextureArgs } from './args';
import { Viewport } from './viewport/Viewport';
import { useLandFocus, useRovingRadio } from './focus';

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
  /** compare mode: every installed card runs, so selection reads muted */
  dimUnselected?: boolean;
}) {
  const roving = useRovingRadio(
    models?.length ?? 0,
    models?.findIndex((m) => m.id === selectedId) ?? -1,
    (i) => {
      const m = models?.[i];
      if (m) onSelect(m.id);
    },
  );
  return (
    <div
      className={`backends ${dimUnselected ? 'compareall' : ''}`}
      role='radiogroup'
      aria-label={t('Backend')}
    >
      {models?.map((m, i) => {
        const v = m.versions.find((x) => x.installed) ?? m.versions[0];
        return (
          <button
            key={m.id}
            type='button'
            role='radio'
            aria-checked={selectedId === m.id}
            className={`backend ${selectedId === m.id ? 'on' : ''}`}
            {...roving(i)}
            onClick={() => onSelect(m.id)}
          >
            <span className='bname'>{m.displayName}</span>
            <span className='btags'>
              <span className='mbadge'>{m.license.spdx ?? m.license.name}</span>
              {m.license.requiresAcceptance && (
                <span className='mbadge gate'>{t('license acceptance required')}</span>
              )}
              {(m.license.excludedTerritories?.length ?? 0) > 0 && (
                <span className='mbadge gate'>
                  {t('not available in')}: {m.license.excludedTerritories!.join(', ')}
                </span>
              )}
              {v?.minVramGb !== undefined && (
                <span className='mbadge'>≥{v.minVramGb} GiB VRAM</span>
              )}
              {v?.installed
                ? <span className='mbadge ok'>{t('installed')}</span>
                : <span className='mbadge gate'>{t('not installed')}</span>}
            </span>
          </button>
        );
      })}
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

/** Errors whose remedy lives in Manage models, so the banner offers the door. */
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
            {t('Manage models…')}
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
        setModels(rows.filter((m) =>
          m.kind === 'gen3d' ||
          m.versions.some((v) => v.capabilities?.includes('gen3d'))
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
            <label htmlFor={id} className='optkey mono' title={f.description}>{f.key}</label>
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
      <span className='clitwincmd' title={line} role='note' aria-label={t('CLI twin')}>
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
  { bridge, projectsRoot, onCreated, onOpenModels, catalogEpoch, vramGb }: {
    bridge: StudioBridge;
    projectsRoot: string;
    /** called with the new CHARACTER ID after gen exits 0 - the App re-reads
     * the list and resolves the workspace dir in the shell's own notation */
    onCreated: (characterId: string) => void;
    onOpenModels: () => void;
    /** bumped when Manage models closes - the backend cards re-read the catalog */
    catalogEpoch?: number;
    /** the health exam's measured VRAM (F3) - null until an exam has run */
    vramGb?: number | null;
  },
) {
  const [name, setName] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const { models, error: catalogError } = useGenBackends(bridge, true, catalogEpoch);
  const [modelId, setModelId] = useState('fixture-gen');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [run, setRun] = useState<{ running: boolean; lines: number; last: string } | null>(null);
  const [failure, setFailure] = useState<JobFailure | null>(null);
  // DEFAULT 2: one job, candidate i at seed + 1000*i, the model loads once -
  // the UX pass asked for the choice up front, not buried in the options form
  const [count, setCount] = useState(2);
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
    bridge.onFileDrop?.((paths) => {
      const img = paths.find((p) => /\.(png|jpe?g|webp)$/i.test(p));
      if (img) setImagePath(img);
    });
  }, [bridge]);

  useEffect(() => {
    if (!imagePath) {
      setPreview(null);
      return;
    }
    let live = true;
    bridge.readImage(imagePath).then((src) => live && setPreview(src), () => {});
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

  // F3: a card the health exam measured at >= 16 GiB should not pay the
  // lowVram tax by default. The flip is an EXPLICIT value, so it travels in
  // --adjust exactly like a hand change, and flipping it back sticks (the
  // `in` guard never overrides a user's own choice).
  useEffect(() => {
    if ((vramGb ?? 0) >= 16 && resolved['lowVram'] === true) {
      setValues((cur) => ('lowVram' in cur ? cur : { ...cur, lowVram: false }));
    }
  }, [vramGb, resolved]);

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
    setScaleWarn(null);
    setRun({ running: true, lines: 0, last: t('starting…') });
    const onLine = (line: string) => {
      let last = line;
      try {
        const e = JSON.parse(line);
        // a progress event NAMES its step (download:model.ckpt, sample,
        // border...) - "3 events · progress" told the user nothing (F5)
        last = e.t === 'progress' && e.step
          ? `${e.step} ${e.done}/${e.total}`
          : e.message ?? e.stage ?? e.t ?? line;
      } catch { /* verbatim */ }
      setRun((cur) => ({
        running: true,
        lines: (cur?.lines ?? 0) + 1,
        last: String(last),
      }));
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
      if (r.exitCode === 0) created = true;
      else fail = lastFailure(r.lines) ?? { code: null, message: '' };
      // the scale warn is the one a user must SEE before they build five
      // stages on a unit-box character (wave 4's fifth finding)
      warn = lastWarnOf(r.lines, 'scale-undeclared') ?? warn;
    }
    setRun({ running: false, lines: 0, last: '' });
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

  return (
    <div className='gennew'>
      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('New character')}</span>
          <span className='ieyebrow mono'>01// GEN</span>
        </div>
        <div className='genrow'>
          <label htmlFor='gname'>{t('Name')}</label>
          <input
            id='gname'
            className='rootinput'
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            autoComplete='off'
          />
          <span className={`slugpreview mono ${problem ? 'bad' : ''}`}>
            {t('id')}: {slug || '—'}
            {problem && name.length > 0 ? ` · ${problemText(problem)}` : ''}
          </span>
        </div>
        <div className='genrow'>
          <label htmlFor='gimage'>{t('Source image')}</label>
          <input
            id='gimage'
            className='rootinput'
            value={imagePath}
            onChange={(e) => setImagePath(e.target.value)}
            placeholder={t('drop an image anywhere, or paste a path')}
            spellCheck={false}
          />
        </div>
        <div className='genrow'>
          <label htmlFor='gheight'>{t('Height (m)')}</label>
          <input
            id='gheight'
            className='optnum mono'
            value={heightM}
            onChange={(e) => setHeightM(e.target.value)}
            inputMode='decimal'
            spellCheck={false}
          />
          <span className='inote'>
            {t('the size every stage believes — sprites frame at pixels-per-metre')}
          </span>
        </div>
        {preview && (
          <div className='genpreview'>
            <img src={preview} alt={t('Source image')} />
          </div>
        )}
      </section>

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Backend')}</span>
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
          dimUnselected={compare && installedGen.length > 1}
        />
        <div className='genrow'>
          <label htmlFor='gencount'>{t('Candidates')}</label>
          <input
            id='gencount'
            className='optnum mono'
            type='number'
            min={1}
            max={8}
            value={count}
            onChange={(e) => setCount(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
          />
          <span className='inote'>
            {t('one job - the model loads once; candidate 2 runs at seed + 1000')}
          </span>
        </div>
        {installedGen.length > 1 && (
          <div className='genrow'>
            <label className='bindhold'>
              <input
                type='checkbox'
                checked={compare}
                onChange={(e) => setCompare(e.target.checked)}
              />
              {t('Compare backends — one job per installed backend, the count split across them')}
            </label>
            {compare && (
              <span className='inote'>
                {t('each backend runs its own defaults; the cards below label every result')}
              </span>
            )}
          </div>
        )}
        {model && version && !version.installed && (
          <div className='inote'>
            {t('this backend is not installed')} —{' '}
            <button type='button' className='linkish' onClick={onOpenModels}>
              {t('Manage models…')}
            </button>
          </div>
        )}
      </section>

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Options')}</span>
          <span className='inote'>{t('defaults are the catalog’s — only changes travel')}</span>
        </div>
        {fields.some((f) => f.key === 'decimationTarget') && (
          <div className='genrow'>
            <span className='optkey mono'>{t('effort')}</span>
            <span className='m-seg' role='group' aria-label={t('Effort (polygon budget)')}>
              {EFFORT_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type='button'
                  className='btn mbtn'
                  aria-pressed={values['decimationTarget'] === p.decimationTarget}
                  onClick={() =>
                    setValues((cur) => ({ ...cur, decimationTarget: p.decimationTarget }))}
                >
                  {p.label}
                </button>
              ))}
            </span>
          </div>
        )}
        <OptionsForm
          fields={fields}
          values={values}
          onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
        />
        {(vramGb ?? 0) >= 16 && values['lowVram'] === false && resolved['lowVram'] === true && (
          <span className='inote'>
            {t('lowVram is off — the health exam found')} {vramGb} GiB
          </span>
        )}
      </section>

      <section className='gensec'>
        {
          /* disabled only for INPUT blockers. While the run is in flight the
            button stays focusable with aria-busy - disabling the focused
            element drops keyboard focus to <body> for the whole run, which
            is the walkthrough's most-repeated finding */
        }
        <button
          type='button'
          className='btn primary genbtn'
          disabled={blocker !== null}
          aria-busy={run?.running === true}
          onClick={generate}
        >
          {run?.running ? t('Generating…') : t('Generate model')}
        </button>
        {!ready && blocker !== null && <span className='blocker mono' role='status'>{blocker}
        </span>}
        {run?.running && (
          <span className='genprogress mono' role='status'>
            {run.lines} {t('events')} · {run.last}
          </span>
        )}
        {failure && <FailureNote failure={failure} onOpenModels={onOpenModels} />}
        {scaleWarn && <span className='mv-warn mono' role='status'>{scaleWarn}</span>}
        <CliTwin args={args} />
        {bridge.name === 'browser-demo' && (
          <div className='inote'>{t('browser preview: generate needs the desktop shell')}</div>
        )}
      </section>
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

/** Where `gen` stored the source image: content-addressed under source/.
 * Mirrors core's sourceImagePath - dot>0, so a dotfile keeps no extension. */
function storedSourcePath(dir: string, m: Record<string, unknown>): string | null {
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
  /** bumped when Manage models closes - the panel's cards re-read the catalog */
  catalogEpoch?: number;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const characterId = typeof m.id === 'string' ? m.id : '';
  const gen = (m.generation ?? {}) as Record<string, unknown>;
  const results = (Array.isArray(gen.results) ? gen.results : []) as ResultEntry[];
  const picked = typeof gen.pickedResultId === 'string' ? gen.pickedResultId : undefined;
  const canonical = m.canonicalMesh !== undefined && m.canonicalMesh !== null;

  const [inspecting, setInspecting] = useState<string | null>(null);
  const [reproject, setReproject] = useState(true);
  const [colorMatch, setColorMatch] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
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
    setFailures({});
    const r = await bridge.runCli([...cliArgs, '--json']);
    setBusy(null);
    if (r.exitCode === 0) onChanged();
    else {
      setFailures({ [cardId]: lastFailure(r.lines) ?? { code: null, message: '' } });
    }
  }, [bridge, onChanged, busy]);

  const doPick = useCallback(
    (id: string) => runFor(id, id, pickFor(id)),
    [runFor, pickFor],
  );
  // gen ALWAYS requires --character (the field test's first error)
  const moreLike = useCallback(
    (id: string) => runFor(id, id, moreLikeArgs(dir, characterId, id)),
    [runFor, dir, characterId],
  );
  // a NEW texture on this result's mesh - core appends a new result card
  const retexture = useCallback(
    (id: string) => runFor(`retex:${id}`, id, retextureArgs(dir, id)),
    [runFor, dir],
  );

  return (
    <div className='cands'>
      {canonical && (
        <div className='checkpoint'>
          <span className='hud'>{t('canonical mesh saved')}</span>
          <span className='mono'>
            {picked ? `${t('pick')} ${picked}` : ''} · {t('stages 02–06 are unlocked')}
          </span>
        </div>
      )}
      {results.length === 0 && (
        <div className='empty'>
          <p>{t('nothing generated')}</p>
        </div>
      )}
      {(inspecting !== null || canonical) && (
        <div className='candvp'>
          <div className='candvplabel mono' role='status'>
            {t('inspecting')}: {inspecting ?? t('canonical mesh')}
          </div>
          <Viewport
            bridge={bridge}
            meshPath={inspecting !== null
              ? `${dir}/results/${inspecting}/model.glb`
              : `${dir}/canonical/model.glb`}
            contentKey={String(
              (m.canonicalMesh as { gltfSha256?: string } | undefined)?.gltfSha256 ?? '',
            )}
          />
        </div>
      )}
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
              {r.output?.tris !== undefined ? ` · ${(r.output.tris / 1000).toFixed(0)}k tris` : ''}
              {r.output?.textureRes !== undefined ? ` · ${r.output.textureRes}px` : ''}
              {r.wallTimeS !== undefined ? ` · ${Math.round(r.wallTimeS)}s` : ''}
            </div>
            <div className='candacts'>
              <button
                type='button'
                className='btn mbtn'
                aria-pressed={inspecting === r.id}
                onClick={() => setInspecting(inspecting === r.id ? null : r.id)}
              >
                {t('Inspect')}
              </button>
              <button
                type='button'
                className='btn mbtn'
                disabled={busy !== null && busy !== r.id}
                aria-busy={busy === r.id}
                onClick={() => moreLike(r.id)}
                title={t('re-runs this result’s recipe with a new seed')}
              >
                {busy === r.id ? t('Working…') : (
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
              <button
                type='button'
                className='btn mbtn primaryish'
                disabled={busy !== null && busy !== r.id}
                aria-busy={busy === r.id}
                onClick={() => doPick(r.id)}
              >
                {t('Save as canonical mesh')}
              </button>
            </div>
            {failures[r.id] && (
              <FailureNote
                failure={failures[r.id]!}
                onOpenModels={onOpenModels}
              />
            )}
          </div>
        ))}
      </div>
      {results.length > 0 && (
        <div className='pickopts'>
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
          <CliTwin args={pickFor(results[0]?.id ?? 'rN')} />
        </div>
      )}
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
    </div>
  );
}

/* ---------------- Generate more (the full-control panel) ---------------- */

/** Effort as a polygon budget. The presets are UI shorthand over the raw
 * field, which stays visible and editable - medium matches what the shipped
 * defaults have produced in practice (~200k tris on the reference images). */
const EFFORT_PRESETS = [
  { key: 'low', label: 'low', decimationTarget: 50_000 },
  { key: 'medium', label: 'medium', decimationTarget: 200_000 },
  { key: 'high', label: 'high', decimationTarget: 800_000 },
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
    runFor: (key: string, cardId: string, cliArgs: string[]) => Promise<void>;
    failure: JobFailure | null;
    onOpenModels: () => void;
    catalogEpoch?: number;
  },
) {
  const { models, error: catalogError } = useGenBackends(bridge, true, catalogEpoch);
  // default to the backend that made the newest result - "more of what I
  // just got" is the likeliest intent
  const [modelId, setModelId] = useState(() => results.at(-1)?.backend?.modelId ?? 'fixture-gen');
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
    <section className='gensec gmore'>
      <div className='gensechead'>
        <span className='hud'>{t('Generate more')}</span>
        <span className='inote'>
          {t('full control — the source image is the one this character was made from')}
        </span>
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
      <div className='genrow'>
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
        <label htmlFor='gmheight'>{t('Height (m)')}</label>
        <input
          id='gmheight'
          className='optnum mono'
          value={heightM}
          onChange={(e) => setHeightM(e.target.value)}
          inputMode='decimal'
          spellCheck={false}
        />
        {hasDecimation && (
          <>
            <span className='optkey mono'>{t('effort')}</span>
            <span className='m-seg' role='group' aria-label={t('Effort (polygon budget)')}>
              {EFFORT_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type='button'
                  className='btn mbtn'
                  aria-pressed={values['decimationTarget'] === p.decimationTarget}
                  onClick={() =>
                    setValues((cur) => ({ ...cur, decimationTarget: p.decimationTarget }))}
                >
                  {p.label}
                </button>
              ))}
            </span>
          </>
        )}
      </div>
      <OptionsForm
        fields={fields}
        values={values}
        onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
      />
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
              {t('Manage models…')}
            </button>
          </span>
        )}
      </div>
      {failure && <FailureNote failure={failure} onOpenModels={onOpenModels} />}
      <CliTwin args={args} />
    </section>
  );
}
