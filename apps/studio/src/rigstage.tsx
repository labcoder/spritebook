/**
 * Stage 02 (P4-T2): run/re-run the rig, read the deform report the way core
 * wrote it, repair with the real verbs, and ACCEPT — the explicit user act
 * every bake warning has been pointing at since P3. The report table is the
 * report verbatim: flags, stretch, displacement; nothing summarized away.
 */
import { useCallback, useEffect, useState } from 'react';
import type { StudioBridge } from './bridge';
import { projectReport, type RigReportView, rigRunArgs } from './rig';
import { t } from './i18n';
import { CliTwin } from './gen';
import { acceptRigArgs } from './args';

const BUNDLED_BODY = 'packages/rig/bodies/ubc-male';

interface RunState {
  running: boolean;
  lines: number;
  last: string;
}

function useRigRun(bridge: StudioBridge, onChanged: () => void) {
  const [run, setRun] = useState<RunState | null>(null);
  const [failed, setFailed] = useState(false);
  const exec = useCallback(async (args: string[]) => {
    setFailed(false);
    setRun({ running: true, lines: 0, last: t('starting…') });
    const r = await bridge.runCli([...args, '--json'], (line) => {
      let last = line;
      try {
        const e = JSON.parse(line);
        last = e.message ?? e.stage ?? e.t ?? line;
      } catch { /* verbatim */ }
      setRun((cur) => ({ running: true, lines: (cur?.lines ?? 0) + 1, last: String(last) }));
    });
    setRun({ running: false, lines: r.lines.length, last: '' });
    if (r.exitCode === 0) onChanged();
    else setFailed(true);
    return r.exitCode;
  }, [bridge, onChanged]);
  return { run, failed, exec };
}

/* ---------------- no rig yet: the run panel ---------------- */

function RunRig({ bridge, dir, onChanged }: {
  bridge: StudioBridge;
  dir: string;
  onChanged: () => void;
}) {
  const [trackA, setTrackA] = useState(false);
  const [bodyDir, setBodyDir] = useState(BUNDLED_BODY);
  const { run, failed, exec } = useRigRun(bridge, onChanged);
  const args = rigRunArgs(dir, trackA ? { trackA: true, bodyDir } : {});

  return (
    <section className='gensec'>
      <div className='gensechead'>
        <span className='hud'>{t('Rig this character')}</span>
        <span className='ieyebrow mono'>02// RIG</span>
      </div>
      <div className='backends' role='radiogroup' aria-label={t('Rig track')}>
        <button
          type='button'
          role='radio'
          aria-checked={!trackA}
          className={`backend ${!trackA ? 'on' : ''}`}
          onClick={() => setTrackA(false)}
        >
          <span className='bname'>{t('Track B — predicted skeleton (UniRig)')}</span>
          <span className='inote'>
            {t('a fresh skeleton fitted to this mesh on the GPU — about two minutes')}
          </span>
        </button>
        <button
          type='button'
          role='radio'
          aria-checked={trackA}
          className={`backend ${trackA ? 'on' : ''}`}
          onClick={() => setTrackA(true)}
        >
          <span className='bname'>{t('Track A — canonical body fit')}</span>
          <span className='inote'>
            {t('the bundled body fitted to the mesh — deterministic, no GPU')}
          </span>
        </button>
      </div>
      {trackA && (
        <div className='genrow'>
          <label htmlFor='rigbody'>{t('Body')}</label>
          <input
            id='rigbody'
            className='rootinput'
            value={bodyDir}
            onChange={(e) => setBodyDir(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
      <div className='genrow'>
        <button
          type='button'
          className='btn primary'
          disabled={run?.running === true}
          onClick={() => exec(args)}
        >
          {run?.running ? t('Rigging…') : t('Run rig')}
        </button>
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
      </div>
      <CliTwin args={args} />
    </section>
  );
}

/* ---------------- rig recorded: report + repair + accept ---------------- */

function flagClass(flag: string): string {
  return flag === 'excessive-stretch' ? 'sun' : 'signal';
}

function ReportTable({ view }: { view: RigReportView }) {
  return (
    <div className='rigreport'>
      <div className='inote'>
        {view.flagged.length} {t('of')} {view.totalJoints} {t('joints flagged under test poses')}
        {' '}
        ({view.poses.join(', ')}) · {view.cleanCount} {t('clean')}
      </div>
      <table className='rigtable'>
        <thead>
          <tr>
            <th scope='col'>{t('joint')}</th>
            <th scope='col'>{t('finding')}</th>
            <th scope='col' className='num'>{t('max stretch')}</th>
            <th scope='col' className='num'>{t('mean move')}</th>
          </tr>
        </thead>
        <tbody>
          {view.flagged.map((j) => (
            <tr key={j.joint}>
              <td className='mono'>{j.joint}</td>
              <td>
                {j.flags.map((f) => <span key={f} className={`mbadge ${flagClass(f)}`}>{f}</span>)}
                {j.spannedComponents > 1 && (
                  <span className='mbadge signal' title={t('no placement hint can repair this')}>
                    {j.spannedComponents} {t('detached pieces')}
                  </span>
                )}
              </td>
              <td className='mono num'>
                {j.maxEdgeStretch > 0 ? `×${j.maxEdgeStretch.toFixed(2)}` : '—'}
              </td>
              <td className='mono num'>{(j.meanDisplacementM * 1000).toFixed(0)} mm</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RigStage({ bridge, dir, manifest, onChanged }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const rig = m.rig as
    | { track?: string; accepted?: boolean; jointCount?: number }
    | undefined;
  const [report, setReport] = useState<RigReportView | null>(null);
  const [editsPath, setEditsPath] = useState('');
  const { run, failed, exec } = useRigRun(bridge, onChanged);

  useEffect(() => {
    let live = true;
    setReport(null);
    bridge.readRigReport(dir).then(
      (r) => live && setReport(projectReport(r)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [bridge, dir, rig?.accepted]);

  if (!rig) return <RunRig bridge={bridge} dir={dir} onChanged={onChanged} />;

  const accepted = rig.accepted === true;
  const acceptArgs = acceptRigArgs(dir, accepted);
  const busy = run?.running === true;

  return (
    <div className='rigstage'>
      {accepted && (
        <div className='checkpoint'>
          <span className='hud'>{t('rig accepted')}</span>
          <span className='mono'>
            {rig.jointCount} {t('joints')} · {t('track')} {rig.track} · {t('Anim is next')}
          </span>
        </div>
      )}

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Deform check')}</span>
          <span className='ieyebrow mono'>02// RIG</span>
        </div>
        {report === null
          ? (
            <div className='inote'>
              {t('no deform report on disk — re-run the rig to write one')}
            </div>
          )
          : report.flagged.length === 0
          ? <div className='inote'>{t('every joint passed the test poses')}</div>
          : <ReportTable view={report} />}
      </section>

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Orientation')}</span>
          <span className='inote'>{t('each fix re-runs the rig (~2 min)')}</span>
        </div>
        <div className='candacts'>
          <button
            type='button'
            className='btn mbtn'
            disabled={busy}
            onClick={() => exec(rigRunArgs(dir, { fixes: ['face-front'] }))}
          >
            {t('Face front')}
          </button>
          <button
            type='button'
            className='btn mbtn'
            disabled={busy}
            onClick={() => exec(rigRunArgs(dir, { fixes: ['feet-ground'] }))}
          >
            {t('Feet to ground')}
          </button>
          <button
            type='button'
            className='btn mbtn'
            disabled={busy}
            onClick={() => exec(rigRunArgs(dir, { fixes: ['center'] }))}
          >
            {t('Center')}
          </button>
          {(['90', '180', '270'] as const).map((deg) => (
            <button
              key={deg}
              type='button'
              className='btn mbtn'
              disabled={busy}
              onClick={() => exec(rigRunArgs(dir, { fixes: [`rotate-${deg}`] }))}
            >
              {t('Rotate')} {deg}°
            </button>
          ))}
        </div>
        <div className='inote'>
          {t(
            'face-front first: every direction is derived from the front, so a wrong front makes all eight wrong',
          )}
        </div>
      </section>

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Repair')}</span>
        </div>
        <div className='candacts'>
          <button
            type='button'
            className='btn mbtn'
            disabled={busy}
            onClick={() => exec(rigRunArgs(dir, { autoHints: true }))}
          >
            {t('Auto-hint from this report and re-run')}
          </button>
          <button
            type='button'
            className='btn mbtn'
            disabled={busy}
            onClick={() => exec(rigRunArgs(dir, {}))}
          >
            {t('Re-run rig')}
          </button>
        </div>
        <div className='genrow'>
          <label htmlFor='editspath'>{t('Joint edits file')}</label>
          <input
            id='editspath'
            className='rootinput'
            value={editsPath}
            onChange={(e) => setEditsPath(e.target.value)}
            placeholder='patch.json'
            spellCheck={false}
          />
          <button
            type='button'
            className='btn mbtn'
            disabled={busy || editsPath.length === 0}
            onClick={() => exec(rigRunArgs(dir, { editsPath }))}
          >
            {t('Apply edits')}
          </button>
          <button
            type='button'
            className='btn mbtn'
            disabled={busy || editsPath.length === 0}
            onClick={() => exec(rigRunArgs(dir, { editsPath, rerunWithHints: true }))}
          >
            {t('Re-run with edits as hints')}
          </button>
        </div>
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
      </section>

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{accepted ? t('Acceptance') : t('Accept this rig')}</span>
        </div>
        {!accepted && (
          <div className='inote'>
            {t(
              'acceptance is yours, not a default: if you have looked and the sprites are fine, record it — the bake stops warning',
            )}
          </div>
        )}
        <div className='genrow'>
          <button
            type='button'
            className={accepted ? 'btn mbtn' : 'btn primary'}
            disabled={busy}
            onClick={() => exec(acceptArgs)}
          >
            {accepted ? t('Unaccept rig') : t('Accept rig')}
          </button>
        </div>
        <CliTwin args={acceptArgs} />
      </section>
    </div>
  );
}
