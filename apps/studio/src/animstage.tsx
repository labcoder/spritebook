/**
 * Stage 03 (P4-T2): the clip library from the real pack metadata, bindings
 * as journaled decisions through `anim --enable/--disable`, and the frames
 * math stated where the choice is made — Look bakes exactly what this stage
 * records, so the cost of a binding is visible before anything runs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StudioBridge } from './bridge';
import { t } from './i18n';
import { CliTwin } from './gen';
import { bindingSpec, framesMath } from './bindings';

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
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // per-clip DRAFT numbers, edited before enable / re-enable records them
  const [drafts, setDrafts] = useState<
    Record<string, { frames: number; speed: number; holdLast: boolean }>
  >({});

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

  const run = useCallback(async (args: string[]) => {
    setBusy(true);
    setFailed(false);
    const r = await bridge.runCli([...args, '--json']);
    setBusy(false);
    if (r.exitCode === 0) onChanged();
    else setFailed(true);
  }, [bridge, onChanged]);

  const draftFor = (clipId: string) => {
    const b = bound.get(clipId);
    return drafts[clipId] ??
      (b
        ? { frames: b.frames, speed: b.speed, holdLast: b.holdLast }
        : { frames: 6, speed: 1, holdLast: false });
  };

  const enable = (clipId: string) => {
    const d = draftFor(clipId);
    run(['anim', '--enable', bindingSpec({ clipId, ...d }), '--workspace', dir]);
  };

  const math = framesMath(bindings, 8);
  const enabledTwin = bindings.filter((b) => b.enabled).map(bindingSpec).join(',');

  return (
    <div className='animstage'>
      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Enabled clips')}</span>
          <span className='ieyebrow mono'>03// ANIM</span>
        </div>
        {bindings.length === 0
          ? <div className='inote'>{t('nothing enabled — pick clips from the library below')}</div>
          : (
            <>
              <div className='bindrows'>
                {bindings.map((b) => {
                  const d = draftFor(b.clipId);
                  const dirty = b.enabled &&
                    (d.frames !== b.frames || d.speed !== b.speed || d.holdLast !== b.holdLast);
                  return (
                    <div key={b.clipId} className={`bindrow ${b.enabled ? '' : 'off'}`}>
                      <span className='mono bindid'>{b.clipId}</span>
                      <label className='bindnum'>
                        {t('frames')}
                        <input
                          type='number'
                          className='optnum mono'
                          min={1}
                          value={d.frames}
                          aria-label={`${b.clipId} ${t('frames')}`}
                          onChange={(e) =>
                            setDrafts((cur) => ({
                              ...cur,
                              [b.clipId]: { ...d, frames: Number(e.target.value) || 1 },
                            }))}
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
                            setDrafts((cur) => ({
                              ...cur,
                              [b.clipId]: { ...d, speed: Number(e.target.value) || 1 },
                            }))}
                        />
                      </label>
                      <label className='bindhold'>
                        <input
                          type='checkbox'
                          checked={d.holdLast}
                          aria-label={`${b.clipId} ${t('hold last frame')}`}
                          onChange={(e) =>
                            setDrafts((cur) => ({
                              ...cur,
                              [b.clipId]: { ...d, holdLast: e.target.checked },
                            }))}
                        />
                        {t('hold last')}
                      </label>
                      {b.enabled
                        ? (
                          <span className='candacts'>
                            {dirty && (
                              <button
                                type='button'
                                className='btn mbtn primaryish'
                                disabled={busy}
                                onClick={() => enable(b.clipId)}
                              >
                                {t('Record change')}
                              </button>
                            )}
                            <button
                              type='button'
                              className='btn mbtn'
                              disabled={busy}
                              onClick={() =>
                                run(['anim', '--disable', b.clipId, '--workspace', dir])}
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
                              disabled={busy}
                              onClick={() => enable(b.clipId)}
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
        {enabledTwin.length > 0 && (
          <CliTwin args={['anim', '--enable', enabledTwin, '--workspace', dir]} />
        )}
        {failed && (
          <span className='mv-exit mono'>
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
                    disabled={busy}
                    onClick={() => enable(c.id)}
                  >
                    {t('Enable')}
                  </button>
                )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
