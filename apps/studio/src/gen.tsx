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
import { genArgs, moreLikeArgs, pickArgs } from './args';

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

function useGenBackends(bridge: StudioBridge, open: boolean) {
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
  }, [bridge, open]);
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
      <span className='clitwincmd' title={line} tabIndex={0} role='note' aria-label={t('CLI twin')}>
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

export function GenerateNew({ bridge, projectsRoot, onCreated, onOpenModels }: {
  bridge: StudioBridge;
  projectsRoot: string;
  /** called with the new CHARACTER ID after gen exits 0 - the App re-reads
   * the list and resolves the workspace dir in the shell's own notation */
  onCreated: (characterId: string) => void;
  onOpenModels: () => void;
}) {
  const [name, setName] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const { models, error: catalogError } = useGenBackends(bridge, true);
  const [modelId, setModelId] = useState('fixture-gen');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [run, setRun] = useState<{ running: boolean; lines: number; last: string } | null>(null);
  const [failed, setFailed] = useState(false);

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
  const resolved = useMemo(
    () => version ? resolveOpDefaults(version.defaults, version.operationDefaults, 'gen3d') : {},
    [version],
  );
  const fields = useMemo(
    () => (version ? schemaFields(version.paramsSchema, resolved) : []),
    [version, resolved],
  );

  const workspace = `${projectsRoot}/${slug || '<id>'}`;
  const args = useMemo(() => {
    const rest = { ...values };
    delete rest['seed'];
    delete rest['candidates'];
    const seed = values['seed'];
    const cand = values['candidates'];
    return genArgs(workspace, {
      characterId: slug || '<id>',
      imagePath,
      modelId,
      adjust: adjustArg(rest, resolved),
      ...(seed !== undefined && seed !== resolved['seed'] ? { seed: Number(seed) } : {}),
      ...(cand !== undefined ? { candidates: Number(cand) } : {}),
    });
  }, [workspace, slug, imagePath, modelId, values, resolved]);

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
    : null;
  const ready = blocker === null && run?.running !== true;

  const generate = useCallback(async () => {
    setFailed(false);
    setRun({ running: true, lines: 0, last: t('starting…') });
    const r: CliRun = await bridge.runCli([...args, '--json'], (line) => {
      let last = line;
      try {
        const e = JSON.parse(line);
        last = e.message ?? e.stage ?? e.t ?? line;
      } catch { /* verbatim */ }
      setRun((cur) => ({
        running: true,
        lines: (cur?.lines ?? 0) + 1,
        last: String(last),
      }));
    });
    setRun({ running: false, lines: r.lines.length, last: '' });
    if (r.exitCode === 0) onCreated(slug);
    else setFailed(true);
  }, [bridge, args, slug, onCreated]);

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
        <div className='backends' role='radiogroup' aria-label={t('Backend')}>
          {models?.map((m) => {
            const v = m.versions.find((x) => x.installed) ?? m.versions[0];
            return (
              <button
                key={m.id}
                type='button'
                role='radio'
                aria-checked={modelId === m.id}
                className={`backend ${modelId === m.id ? 'on' : ''}`}
                onClick={() => {
                  setModelId(m.id);
                  setValues({});
                }}
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
        <OptionsForm
          fields={fields}
          values={values}
          onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
        />
      </section>

      <section className='gensec'>
        <button
          type='button'
          className='btn primary genbtn'
          disabled={!ready}
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
        {failed && (
          <span className='mv-exit mono'>
            {t('failed — the log drawer has the verbatim reason')}
          </span>
        )}
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

export function Candidates({ bridge, dir, manifest, onChanged }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const characterId = typeof m.id === 'string' ? m.id : '';
  const gen = (m.generation ?? {}) as Record<string, unknown>;
  const results = (Array.isArray(gen.results) ? gen.results : []) as ResultEntry[];
  const picked = typeof gen.pickedResultId === 'string' ? gen.pickedResultId : undefined;
  const canonical = m.canonicalMesh !== undefined && m.canonicalMesh !== null;

  const [reproject, setReproject] = useState(true);
  const [colorMatch, setColorMatch] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  const pickFor = useCallback(
    (id: string) => pickArgs(dir, id, { reproject, colorMatch }),
    [dir, reproject, colorMatch],
  );

  const doPick = useCallback(async (id: string) => {
    setBusy(id);
    setFailedId(null);
    const r = await bridge.runCli([...pickFor(id), '--json']);
    setBusy(null);
    if (r.exitCode === 0) onChanged();
    else setFailedId(id);
  }, [bridge, pickFor, onChanged]);

  const moreLike = useCallback(async (id: string) => {
    setBusy(id);
    setFailedId(null);
    // gen ALWAYS requires --character (the field test's first error)
    const r = await bridge.runCli([...moreLikeArgs(dir, characterId, id), '--json']);
    setBusy(null);
    if (r.exitCode === 0) onChanged();
    else setFailedId(id);
  }, [bridge, dir, characterId, onChanged]);

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
      <div className='candgrid'>
        {results.map((r) => (
          <div key={r.id} className={`cand ${picked === r.id ? 'picked' : ''}`}>
            <div className='candhead'>
              <span className='mono candid'>{r.id}</span>
              {picked === r.id && <span className='mbadge ok'>{t('picked')}</span>}
              {r.discarded && <span className='mbadge'>{t('discarded')}</span>}
            </div>
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
                disabled={busy !== null}
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
                className='btn mbtn primaryish'
                disabled={busy !== null}
                onClick={() => doPick(r.id)}
              >
                {t('Save as canonical mesh')}
              </button>
            </div>
            {failedId === r.id && (
              <span className='mv-exit mono'>
                {t('failed — the log drawer has the verbatim reason')}
              </span>
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
    </div>
  );
}
