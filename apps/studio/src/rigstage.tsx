import { Inspector } from './workbench';
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
import { CliTwin, FailureNote, type JobFailure, lastFailure } from './gen';
import { JobActivity } from './jobactivity';
import { type ProgressState, readProgress } from './bakeprogress';
import { acceptRigArgs } from './args';
import { Viewport } from './viewport/Viewport';
import { editsFile, mergeEdits, mirrorPartner, type PendingEdit } from './viewport/picking';
import { useLandFocus } from './focus';

const BUNDLED_BODY = 'ubc-male';

interface RunState {
  running: boolean;
  progress: ProgressState | null;
  args: string[];
}

function useRigRun(bridge: StudioBridge, onChanged: () => void) {
  const [run, setRun] = useState<RunState | null>(null);
  const [failure, setFailure] = useState<JobFailure | null>(null);
  const [canceled, setCanceled] = useState(false);
  useLandFocus(canceled, '.rigstage .job-canceled');
  useLandFocus(failure !== null, '.rigstage .mv-exit');
  const exec = useCallback(async (args: string[]) => {
    // every rig verb keeps its button focusable with aria-busy while the run
    // is in flight - disabled would drop keyboard focus to <body>, the
    // walkthrough's most-repeated finding - so a second press lands here and
    // is a no-op (non-zero: nothing ran, callers must not treat it as success)
    if (run?.running) return 1;
    setFailure(null);
    setCanceled(false);
    setRun({ running: true, progress: null, args });
    const r = await bridge.runCli([...args, '--json'], (line) => {
      const progress = readProgress(line);
      if (progress) setRun({ running: true, progress, args });
    });
    setRun({ running: false, progress: null, args });
    if (r.exitCode === 0) onChanged();
    else if (r.exitCode === 130) setCanceled(true);
    else {setFailure(
        lastFailure(r.lines) ??
          { code: null, message: t('the log drawer has the verbatim reason') },
      );}
    return r.exitCode;
  }, [bridge, onChanged, run]);
  return { run, failure, canceled, exec };
}

/* ---------------- no rig yet: the run panel ---------------- */

function RunRig({ bridge, dir, onChanged }: {
  bridge: StudioBridge;
  dir: string;
  onChanged: () => void;
}) {
  const [trackA, setTrackA] = useState(false);
  const [bodyDir, setBodyDir] = useState(BUNDLED_BODY);
  const { run, failure, canceled, exec } = useRigRun(bridge, onChanged);
  const args = rigRunArgs(dir, trackA ? { trackA: true, bodyDir } : {});

  return (
    <div className='rigstage rig-setup'>
      <div className='rigcols'>
        <div className='rigside asset-workspace'>
          <section className='gensec'>
            <div className='gensechead'>
              <span className='hud'>{t('Canonical mesh')}</span>
              <span className='inote'>
                {t('what the rig will be fitted to — the mesh you just picked')}
              </span>
            </div>
            {
              /* F12: the pre-rig screen was two-thirds blank while the mesh the
              user picked ten seconds earlier sat unseen on disk */
            }
            <Viewport bridge={bridge} meshPath={`${dir}/canonical/model.glb`} />
          </section>
        </div>
        <Inspector className='rigmain'>
          <section className='gensec rig-controls' tabIndex={0} aria-label={t('Rig track')}>
            <div className='gensechead'>
              <span className='hud'>{t('Rig this character')}</span>
            </div>
            <fieldset className='settings-group' disabled={run?.running}>
              <div className='backends' role='radiogroup' aria-label={t('Rig track')}>
                <label className={`backend ${!trackA ? 'on' : ''}`}>
                  <input
                    type='radio'
                    name='rig-track'
                    checked={!trackA}
                    onChange={() => setTrackA(false)}
                  />
                  <span className='backend-copy'>
                    <span className='bname'>{t('Track B — predicted skeleton (UniRig)')}</span>
                    <span className='inote'>
                      {t('GPU-based skeleton prediction and skinning.')}
                    </span>
                  </span>
                </label>
                <label className={`backend ${trackA ? 'on' : ''}`}>
                  <input
                    type='radio'
                    name='rig-track'
                    checked={trackA}
                    onChange={() => setTrackA(true)}
                  />
                  <span className='backend-copy'>
                    <span className='bname'>{t('Track A — canonical body fit')}</span>
                    <span className='inote'>
                      {t('the bundled body fitted to the mesh — deterministic, no GPU')}
                    </span>
                  </span>
                </label>
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
            </fieldset>
          </section>
          <section className='gensec action-section'>
            <div className='genrow'>
              <button
                type='button'
                className='btn primary'
                aria-busy={run?.running === true}
                onClick={() => exec(args)}
              >
                {run?.running ? t('Rigging…') : t('Run rig')}
              </button>
              {run?.running && <JobActivity progress={run.progress} verb='rig' />}
              {failure && <FailureNote failure={failure} />}
              {canceled && <p className='inote job-canceled' role='status'>{t('Job canceled')}</p>}
            </div>
            <CliTwin args={args} />
          </section>
        </Inspector>
      </div>
    </div>
  );
}

/* ---------------- rig recorded: report + repair + accept ---------------- */

function flagClass(flag: string): string {
  return flag === 'excessive-stretch' ? 'sun' : 'signal';
}

function ReportTable({ view, onFocusJoint }: {
  view: RigReportView;
  /** a row's activation selects and frames that joint in the canvas */
  onFocusJoint: (joint: string) => void;
}) {
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
              <td className='mono'>
                <button
                  type='button'
                  className='linkish mono'
                  title={t('select and frame this joint in the canvas')}
                  onClick={() => onFocusJoint(j.joint)}
                >
                  {j.joint}
                </button>
              </td>
              <td>
                {j.flags.map((f) => <span key={f} className={`mbadge ${flagClass(f)}`}>{f}</span>)}
                {j.spannedComponents > 1 && (
                  <span
                    className='mbadge signal'
                    title={t('no placement hint can repair this')}
                  >
                    {j.spannedComponents} {t('detached pieces')}
                  </span>
                )}
              </td>
              <td className='mono num'>
                {j.maxEdgeStretch > 0 ? `×${j.maxEdgeStretch.toFixed(2)}` : '—'}
              </td>
              <td className='mono num'>
                {(j.meanDisplacementM * 1000).toFixed(0)} mm
              </td>
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
  const [edits, setEdits] = useState<PendingEdit[]>([]);
  const [mirror, setMirror] = useState(false);
  const [selectedJoint, setSelectedJoint] = useState<string | null>(null);
  // a deform row's activation lands here; the counter re-fires repeat clicks
  const [focusJoint, setFocusJoint] = useState<{ name: string; n: number } | null>(null);
  // the re-run track DEFAULTS to the recorded one - before this, every
  // re-run silently flipped a track-A character back to track B
  const [rerunTrackA, setRerunTrackA] = useState((rig?.track ?? 'B') === 'A');
  const [rerunBody, setRerunBody] = useState(BUNDLED_BODY);
  const rerunOpts = rerunTrackA ? { trackA: true as const, bodyDir: rerunBody } : {};
  const { run, failure, canceled, exec } = useRigRun(bridge, onChanged);

  // the first successful run unmounts RunRig under the focused button — land
  // on the deform report that replaced it
  useLandFocus(rig !== undefined, '.rigdeform');
  // applying or discarding the pending edits unmounts the edits block under
  // the focused button — land on the repair verbs, where the next act lives
  useLandFocus(edits.length === 0, '.rigrerun');

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

  // the nudges become a patch file core reads, then the rig re-runs with it:
  // the GUI never edits a skeleton itself (invariant 1)
  const applyEdits = async () => {
    if (edits.length === 0) return;
    try {
      const path = await bridge.writeRigEdits(
        dir,
        JSON.stringify(editsFile(edits), null, 2),
      );
      const code = await exec(rigRunArgs(dir, { editsPath: path }));
      if (code === 0) setEdits([]);
    } catch {
      // writeRigEdits refuses in the browser demo; the drawer carries it
    }
  };

  if (!rig) return <RunRig bridge={bridge} dir={dir} onChanged={onChanged} />;

  const accepted = rig.accepted === true;
  const acceptArgs = acceptRigArgs(dir, accepted);
  const busy = run?.running === true;

  return (
    <div className='rigstage'>
      <div className='rigcols'>
        <div className='rigside asset-workspace'>
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
              <span className='hud'>{t('Joints')}</span>
              <span className='inote'>
                {t(
                  'click a joint, drag the gizmo — W move · E rotate · Q local/world',
                )}
              </span>
            </div>
            <Viewport
              bridge={bridge}
              meshPath={`${dir}/rig/rigged.glb`}
              contentKey={String(
                (m.canonicalMesh as { gltfSha256?: string } | undefined)
                  ?.gltfSha256 ?? '',
              )}
              focusJoint={focusJoint}
              showSkeleton
              onNudge={(e) =>
                setEdits((cur) =>
                  mergeEdits(cur, {
                    joint: e.joint,
                    delta: e.delta,
                    mirrored: mirror,
                  })
                )}
              onJointSelected={setSelectedJoint}
            />
            <div className='genrow'>
              <label className='bindhold'>
                <input
                  type='checkbox'
                  checked={mirror}
                  onChange={(e) => setMirror(e.target.checked)}
                />
                {t('mirror to the other side')}
              </label>
              {selectedJoint && (
                <span className='mono dimtext'>
                  {mirror && mirrorPartner(selectedJoint)
                    ? `${selectedJoint} + ${mirrorPartner(selectedJoint)}`
                    : mirror
                    ? `${selectedJoint} · ${t('no side partner — this joint moves alone')}`
                    : selectedJoint}
                </span>
              )}
            </div>
            {edits.length > 0 && (
              <>
                <div className='bindrows'>
                  {edits.map((e) => (
                    <div key={e.joint} className='bindrow'>
                      <span className='mono bindid'>{e.joint}</span>
                      <span className='mono clipmeta'>
                        {e.delta.map((v) => `${(v * 1000).toFixed(1)}mm`).join(
                          ' · ',
                        )}
                      </span>
                      {e.mirrored && <span className='mbadge'>{t('mirrored')}</span>}
                      <span className='candacts'>
                        <button
                          type='button'
                          className='btn mbtn'
                          onClick={() => setEdits((cur) => cur.filter((x) => x.joint !== e.joint))}
                        >
                          {t('Discard')}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
                <div className='genrow'>
                  <button
                    type='button'
                    className='btn primary'
                    aria-busy={busy}
                    onClick={applyEdits}
                  >
                    {busy ? t('Applying…') : t('Apply joint edits and re-rig')}
                  </button>
                  <button
                    type='button'
                    className='btn mbtn'
                    disabled={busy}
                    onClick={() => setEdits([])}
                  >
                    {t('Discard all')}
                  </button>
                  <span className='inote'>
                    {t('writes rig/joint-edits.json, then re-runs the rig')}
                  </span>
                </div>
                <CliTwin
                  args={rigRunArgs(dir, {
                    editsPath: `${dir}/rig/joint-edits.json`,
                  })}
                />
              </>
            )}
          </section>
          {/* .rigdeform is the landing target above — keep it stable */}
          <section className='gensec rigdeform'>
            <div className='gensechead'>
              <span className='hud'>{t('Deform check')}</span>
            </div>
            {report === null
              ? (
                <div className='inote'>
                  {t('no deform report on disk — re-run the rig to write one')}
                </div>
              )
              : report.flagged.length === 0
              ? (
                <div className='inote'>
                  {t('every joint passed the test poses')}
                </div>
              )
              : (
                <ReportTable
                  view={report}
                  onFocusJoint={(j) => setFocusJoint((cur) => ({ name: j, n: (cur?.n ?? 0) + 1 }))}
                />
              )}
          </section>
        </div>
        <Inspector className='rigmain'>
          {run?.running && (
            <div className='rig-activity'>
              <JobActivity progress={run.progress} verb='rig' />
              <CliTwin args={run.args} />
            </div>
          )}
          {failure && <FailureNote failure={failure} />}
          {canceled && <p className='inote job-canceled' role='status'>{t('Job canceled')}</p>}
          <div className='rig-controls'>
            <section className='gensec'>
              <div className='gensechead'>
                <span className='hud'>{t('Orientation')}</span>
                <span className='inote'>
                  {t('Each fix re-runs the rig.')}
                </span>
              </div>
              <div className='candacts'>
                <button
                  type='button'
                  className='btn mbtn'
                  aria-busy={busy}
                  onClick={() => exec(rigRunArgs(dir, { fixes: ['face-front'] }))}
                >
                  {t('Face front')}
                </button>
                <button
                  type='button'
                  className='btn mbtn'
                  aria-busy={busy}
                  onClick={() => exec(rigRunArgs(dir, { fixes: ['feet-ground'] }))}
                >
                  {t('Feet to ground')}
                </button>
                <button
                  type='button'
                  className='btn mbtn'
                  aria-busy={busy}
                  onClick={() => exec(rigRunArgs(dir, { fixes: ['center'] }))}
                >
                  {t('Center')}
                </button>
                {(['90', '180', '270'] as const).map((deg) => (
                  <button
                    key={deg}
                    type='button'
                    className='btn mbtn'
                    aria-busy={busy}
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
                <span className='inote'>
                  {t(
                    'auto-hint turns this report into joint-position hints and re-runs; re-run repeats with no hints',
                  )}
                </span>
              </div>
              <div className='genrow'>
                <span className='m-seg' role='group' aria-label={t('Re-run track')}>
                  <button
                    type='button'
                    className='btn mbtn'
                    aria-pressed={!rerunTrackA}
                    onClick={() => setRerunTrackA(false)}
                  >
                    {t('Track B')}
                  </button>
                  <button
                    type='button'
                    className='btn mbtn'
                    aria-pressed={rerunTrackA}
                    onClick={() => setRerunTrackA(true)}
                  >
                    {t('Track A')}
                  </button>
                </span>
                {rerunTrackA && (
                  <input
                    className='rootinput'
                    aria-label={t('Body')}
                    value={rerunBody}
                    onChange={(e) => setRerunBody(e.target.value)}
                    spellCheck={false}
                  />
                )}
              </div>
              <div className='candacts'>
                <button
                  type='button'
                  className='btn mbtn'
                  aria-busy={busy}
                  onClick={() => exec(rigRunArgs(dir, { ...rerunOpts, autoHints: true }))}
                >
                  {t('Auto-hint from this report and re-run')}
                </button>
                <button
                  type='button'
                  className='btn mbtn rigrerun'
                  aria-busy={busy}
                  onClick={() => exec(rigRunArgs(dir, { ...rerunOpts }))}
                >
                  {t('Re-run rig')}
                </button>
              </div>
              <details className='panel-disclosure'>
                <summary>{t('Joint edits file')}</summary>
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
                    disabled={editsPath.length === 0}
                    aria-busy={busy}
                    onClick={() => exec(rigRunArgs(dir, { ...rerunOpts, editsPath }))}
                  >
                    {t('Apply edits')}
                  </button>
                  <button
                    type='button'
                    className='btn mbtn'
                    disabled={editsPath.length === 0}
                    aria-busy={busy}
                    onClick={() =>
                      exec(rigRunArgs(dir, { ...rerunOpts, editsPath, rerunWithHints: true }))}
                  >
                    {t('Re-run with edits as hints')}
                  </button>
                </div>
              </details>
            </section>
          </div>
          <section className='gensec action-section'>
            <div className='gensechead'>
              <span className='hud'>
                {accepted ? t('Acceptance') : t('Accept this rig')}
              </span>
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
                aria-busy={busy}
                onClick={() => exec(acceptArgs)}
              >
                {accepted ? t('Unaccept rig') : t('Accept rig')}
              </button>
            </div>
            <CliTwin args={acceptArgs} />
          </section>
        </Inspector>
      </div>
    </div>
  );
}
