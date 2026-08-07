/**
 * Stage 03 (P4-T2): the clip library from the real pack metadata, bindings
 * as journaled decisions through `anim --enable/--disable`, and the frames
 * math stated where the choice is made — Look bakes exactly what this stage
 * records, so the cost of a binding is visible before anything runs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StudioBridge } from './bridge';
import { t } from './i18n';
import { CliTwin, FailureNote, type JobFailure, lastFailure } from './gen';
import { useLandFocus } from './focus';
import { bindingSpec, framesMath } from './bindings';
import { animDisableArgs, animEnableArgs, animPreviewArgs } from './args';
import { Viewport } from './viewport/Viewport';

interface ClipMeta {
  id: string;
  name: string;
  category: string;
  tags: string[];
  durationS: number;
  loop: boolean;
}

interface Binding {
  clipId: string;
  packId: string;
  enabled: boolean;
  frames: number;
  speed: number;
  holdLast: boolean;
}

function useLibrary(bridge: StudioBridge) {
  const [clips, setClips] = useState<ClipMeta[] | null>(null);
  const [packId, setPackId] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    bridge.runCli(['anim', '--list', '--json']).then((r) => {
      if (!live) return;
      if (r.exitCode !== 0 || r.lines.length === 0) {
        setError(t('could not read the clip library — the log drawer has the verbatim reason'));
        return;
      }
      try {
        const doc = JSON.parse(r.lines.at(-1)!);
        const first = Array.isArray(doc.packs) ? doc.packs[0] : doc;
        setClips((first?.clips ?? []) as ClipMeta[]);
        setPackId(String(first?.pack ?? ''));
      } catch {
        setError(t('clip library output was not JSON'));
      }
    });
    return () => {
      live = false;
    };
  }, [bridge]);
  return { clips, packId, error };
}

export function AnimStage({ bridge, dir, manifest, onChanged }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const bindings = (Array.isArray(m.animationSet) ? m.animationSet : []) as Binding[];
  const { clips, packId, error } = useLibrary(bridge);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  // one CLI run at a time; the key names the button that owns the run, so
  // only that button reports aria-busy while the rest get a real input block
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // per-clip DRAFT numbers, edited before enable / re-enable records them
  const [drafts, setDrafts] = useState<
    Record<string, { frames: number; speed: number; holdLast: boolean }>
  >({});
  // the rows whose success should catch the keyboard (the useLandFocus calls)
  const [justEnabled, setJustEnabled] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  // D-038: which clip's preview glb the canvas plays. The counter re-loads
  // the SAME path after a re-run - core overwrites preview-<clip>.glb in
  // place, so a path-keyed load would keep showing the previous retarget.
  const [preview, setPreview] = useState<{ clipId: string; n: number } | null>(null);
  const [previewFailure, setPreviewFailure] = useState<JobFailure | null>(null);

  const bound = useMemo(() => new Map(bindings.map((b) => [b.clipId, b])), [bindings]);
  const categories = useMemo(
    () => [...new Set((clips ?? []).map((c) => c.category))].sort(),
    [clips],
  );
  const visible = useMemo(() => {
    const q = query.toLowerCase();
    return (clips ?? []).filter((c) =>
      (category === '' || c.category === category) &&
      (q === '' || c.id.includes(q) || c.name.toLowerCase().includes(q) ||
        c.tags.some((tag) => tag.includes(q)))
    );
  }, [clips, query, category]);

  const run = useCallback(async (key: string, args: string[]) => {
    // disabling the clicked button dropped keyboard focus to <body> for the
    // whole run - the walkthrough's most-repeated finding. The guard does the
    // blocking now; the button stays focusable and reports aria-busy.
    if (busy !== null) return;
    setBusy(key);
    setFailed(false);
    const r = await bridge.runCli([...args, '--json']);
    setBusy(null);
    if (r.exitCode === 0) onChanged();
    else setFailed(true);
  }, [bridge, onChanged, busy]);

  const draftFor = (clipId: string) => {
    const b = bound.get(clipId);
    return drafts[clipId] ??
      (b
        ? { frames: b.frames, speed: b.speed, holdLast: b.holdLast }
        : { frames: 6, speed: 1, holdLast: false });
  };

  const dirtyFor = (b: Binding) => {
    const d = draftFor(b.clipId);
    return b.enabled &&
      (d.frames !== b.frames || d.speed !== b.speed || d.holdLast !== b.holdLast);
  };

  const editDraft = (
    clipId: string,
    patch: Partial<{ frames: number; speed: number; holdLast: boolean }>,
  ) => {
    // an edit re-arms the record cycle - a stale land target must not fire
    // when hand-editing happens to make the row match the manifest again
    setRecorded(null);
    setDrafts((cur) => ({ ...cur, [clipId]: { ...draftFor(clipId), ...patch } }));
  };

  // Success moves the button out from under the keyboard: the library's
  // Enable becomes the static 'enabled' badge while the binding row appears,
  // and Record change unmounts itself once the manifest matches the draft.
  // Land focus where the journey continues - the row's frames input after an
  // enable, the row's Disable after a record. Both conditions read the
  // manifest, so they flip exactly when the new content commits.
  useLandFocus(
    justEnabled !== null && bound.get(justEnabled)?.enabled === true,
    `.bindrow[data-clip="${justEnabled}"] .bindframes`,
  );
  const recordedB = recorded !== null ? bound.get(recorded) : undefined;
  useLandFocus(
    recordedB !== undefined && !dirtyFor(recordedB),
    `.bindrow[data-clip="${recorded}"] .binddisable`,
  );

  const enable = (clipId: string) => {
    const d = draftFor(clipId);
    run(`enable:${clipId}`, animEnableArgs(dir, [bindingSpec({ clipId, ...d })]));
  };

  // regenerate-when-you-look (D-038): every press re-runs the retarget in
  // core; success hands the fresh glb to the canvas, failure names itself
  const runPreview = useCallback(async (clipId: string) => {
    if (busy !== null) return;
    setBusy(`preview:${clipId}`);
    setPreviewFailure(null);
    const r = await bridge.runCli([...animPreviewArgs(dir, clipId), '--json']);
    setBusy(null);
    if (r.exitCode === 0) {
      setPreview((cur) => ({ clipId, n: (cur?.n ?? 0) + 1 }));
    } else {
      setPreviewFailure(
        lastFailure(r.lines) ?? { code: null, message: '' },
      );
    }
  }, [bridge, dir, busy]);

  const math = framesMath(bindings, 8);
  const enabledTwin = bindings.filter((b) => b.enabled).map(bindingSpec).join(',');

  return (
    <div className='animstage rigcols'>
      <div className='rigmain'>
        <section className='gensec'>
          <div className='gensechead'>
            <span className='hud'>{t('Enabled clips')}</span>
            <span className='ieyebrow mono'>03// ANIM</span>
          </div>
          {bindings.length === 0
            ? (
              <div className='inote'>
                {t('nothing enabled — pick clips from the library below')}
              </div>
            )
            : (
              <>
                <div className='bindrows'>
                  {bindings.map((b) => {
                    const d = draftFor(b.clipId);
                    const dirty = dirtyFor(b);
                    return (
                      <div
                        key={b.clipId}
                        className={`bindrow ${b.enabled ? '' : 'off'}`}
                        data-clip={b.clipId}
                      >
                        <span className='mono bindid'>{b.clipId}</span>
                        <label className='bindnum'>
                          {t('frames')}
                          <input
                            type='number'
                            className='optnum mono bindframes'
                            min={1}
                            value={d.frames}
                            aria-label={`${b.clipId} ${t('frames')}`}
                            onChange={(e) =>
                              editDraft(b.clipId, { frames: Number(e.target.value) || 1 })}
                          />
                        </label>
                        <label className='bindnum'>
                          {t('speed')}
                          <input
                            type='number'
                            className='optnum mono'
                            min={0.1}
                            step={0.1}
                            value={d.speed}
                            aria-label={`${b.clipId} ${t('speed')}`}
                            onChange={(e) =>
                              editDraft(b.clipId, { speed: Number(e.target.value) || 1 })}
                          />
                        </label>
                        <label className='bindhold'>
                          <input
                            type='checkbox'
                            checked={d.holdLast}
                            aria-label={`${b.clipId} ${t('hold last frame')}`}
                            onChange={(e) => editDraft(b.clipId, { holdLast: e.target.checked })}
                          />
                          {t('hold last')}
                        </label>
                        {b.enabled
                          ? (
                            <span className='candacts'>
                              <button
                                type='button'
                                className='btn mbtn bindpreview'
                                disabled={busy !== null && busy !== `preview:${b.clipId}`}
                                aria-busy={busy === `preview:${b.clipId}`}
                                onClick={() => runPreview(b.clipId)}
                              >
                                {t('Preview')}
                              </button>
                              {dirty && (
                                /* disabled only blocks the rows that do NOT own
                                 the run - the owning button keeps focus and
                                 reports aria-busy instead */
                                <button
                                  type='button'
                                  className='btn mbtn primaryish'
                                  disabled={busy !== null && busy !== `enable:${b.clipId}`}
                                  aria-busy={busy === `enable:${b.clipId}`}
                                  onClick={() => {
                                    setRecorded(b.clipId);
                                    enable(b.clipId);
                                  }}
                                >
                                  {t('Record change')}
                                </button>
                              )}
                              <button
                                type='button'
                                className='btn mbtn binddisable'
                                disabled={busy !== null && busy !== `disable:${b.clipId}`}
                                aria-busy={busy === `disable:${b.clipId}`}
                                onClick={() =>
                                  run(`disable:${b.clipId}`, animDisableArgs(dir, [b.clipId]))}
                              >
                                {t('Disable')}
                              </button>
                            </span>
                          )
                          : (
                            <span className='candacts'>
                              <span className='mbadge'>{t('disabled')}</span>
                              <button
                                type='button'
                                className='btn mbtn'
                                disabled={busy !== null && busy !== `enable:${b.clipId}`}
                                aria-busy={busy === `enable:${b.clipId}`}
                                onClick={() => {
                                  // re-enabling swaps this button to Disable at
                                  // the same child position, so React keeps the
                                  // element and focus rides the swap - only the
                                  // library path lands on the frames input
                                  setJustEnabled(null);
                                  enable(b.clipId);
                                }}
                              >
                                {t('Re-enable')}
                              </button>
                            </span>
                          )}
                      </div>
                    );
                  })}
                </div>
                <div className='framesmath mono' role='status'>
                  {math.clips} {t('clips')} × {math.directions} {t('directions')} × Ø
                  {math.meanFrames.toFixed(math.meanFrames % 1 === 0 ? 0 : 1)} {t('frames')} ={' '}
                  <b>{math.total}</b> {t('frames per bake pass')}
                </div>
              </>
            )}
          {enabledTwin.length > 0 && <CliTwin args={animEnableArgs(dir, [enabledTwin])} />}
          {failed && (
            <span className='mv-exit mono' role='status'>
              {t('failed — the log drawer has the verbatim reason')}
            </span>
          )}
        </section>

        <section className='gensec'>
          <div className='gensechead'>
            <span className='hud'>{t('Clip library')}</span>
            {packId && <span className='mono dimtext'>{packId}</span>}
            <span className='mono dimtext'>
              {clips ? `${visible.length}/${clips.length}` : '…'}
            </span>
          </div>
          {error && <div className='mdl-error mono'>{error}</div>}
          <div className='genrow'>
            <label htmlFor='clipsearch'>{t('Search')}</label>
            <input
              id='clipsearch'
              className='rootinput'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('name or tag…')}
              spellCheck={false}
            />
            <label htmlFor='clipcat'>{t('Category')}</label>
            <select
              id='clipcat'
              className='optnum mono'
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value=''>{t('all')}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className='cliplist'>
            {visible.map((c) => (
              <div key={c.id} className='cliprow'>
                <span className='mono clipid'>{c.id}</span>
                <span className='mbadge kind'>{c.category}</span>
                <span className='mono clipmeta'>
                  {c.durationS.toFixed(1)}s{c.loop ? ` · ${t('loop')}` : ''}
                </span>
                <span className='cliptags mono' title={c.tags.join(', ')}>
                  {c.tags.slice(0, 4).join(' ')}
                </span>
                {bound.get(c.id)?.enabled === true
                  ? <span className='mbadge ok'>{t('enabled')}</span>
                  : (
                    <button
                      type='button'
                      className='btn mbtn'
                      disabled={busy !== null && busy !== `enable:${c.id}`}
                      aria-busy={busy === `enable:${c.id}`}
                      onClick={() => {
                        // land on the binding row's frames input - the next
                        // thing a keyboard user edits after enabling
                        setJustEnabled(c.id);
                        enable(c.id);
                      }}
                    >
                      {t('Enable')}
                    </button>
                  )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className='rigside'>
        <section className='gensec'>
          <div className='gensechead'>
            <span className='hud'>{t('Motion preview')}</span>
            <span className='inote'>
              {t('core retargets the clip onto this character — the canvas only plays it')}
            </span>
          </div>
          {preview !== null
            ? (
              <>
                <Viewport
                  bridge={bridge}
                  meshPath={`${dir}/anim/preview-${preview.clipId}.glb`}
                  contentKey={`${preview.clipId}:${preview.n}`}
                />
                <CliTwin args={animPreviewArgs(dir, preview.clipId)} />
              </>
            )
            : (
              <div className='inote'>
                {t('press Preview on an enabled clip to see its motion here')}
              </div>
            )}
          {previewFailure && <FailureNote failure={previewFailure} />}
        </section>
      </div>
    </div>
  );
}
