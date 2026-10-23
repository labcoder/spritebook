import { Inspector } from './workbench';
/**
 * Stage 02 (P4-T2): run/re-run the rig, read the deform report the way core
 * wrote it, repair with the real verbs, and ACCEPT — the explicit user act
 * every bake warning has been pointing at since P3. The report table is the
 * report verbatim: flags, stretch, displacement; nothing summarized away.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StudioBridge } from './bridge';
import { projectReport, type RigReportView, rigRunArgs } from './rig';
import { t } from './i18n';
import { CliTwin, FailureNote, type JobFailure, lastFailure } from './gen';
import { JobActivity } from './jobactivity';
import { type ProgressState, readProgress } from './bakeprogress';
import { acceptRigArgs, animPreviewArgs } from './args';
import { Viewport } from './viewport/Viewport';
import { editsFile, mergeEdits, mirrorPartner, type PendingEdit } from './viewport/picking';
import { useLandFocus } from './focus';
import { useClipLibrary } from './clip-library';

const BUNDLED_BODY = 'ubc-male';

interface RunState {
  running: boolean;
  progress: ProgressState | null;
  args: string[];
}

function useRigRun(bridge: StudioBridge, onChanged: (args: string[]) => void) {
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
    try {
      const r = await bridge.runCli([...args, '--json'], (line) => {
        const progress = readProgress(line);
        if (progress) setRun({ running: true, progress, args });
      });
      if (r.exitCode === 0) onChanged(args);
      else if (r.exitCode === 130) setCanceled(true);
      else {setFailure(
          lastFailure(r.lines) ??
            { code: null, message: t('the log drawer has the verbatim reason') },
        );}
      return r.exitCode;
    } catch (error) {
      setFailure({ code: null, message: error instanceof Error ? error.message : String(error) });
      return 1;
    } finally {
      setRun({ running: false, progress: null, args });
    }
  }, [bridge, onChanged, run]);
  return { run, failure, canceled, exec };
}

interface OrientationDraft {
  front: string;
  upright: boolean;
  ground: boolean;
  center: boolean;
}
const REST_ORIENTATION: OrientationDraft = {
  front: 'keep',
  upright: false,
  ground: false,
  center: false,
};
const INITIAL_ORIENTATION: OrientationDraft = {
  front: 'detect',
  upright: true,
  ground: true,
  center: true,
};

function orientationFixes(draft: OrientationDraft): string[] {
  return [
    ...(draft.upright ? ['upright'] : []),
    ...(draft.front === 'detect'
      ? ['face-front']
      : draft.front === 'keep'
      ? []
      : [`rotate-${draft.front}`]),
    ...(draft.ground ? ['feet-ground'] : []),
    ...(draft.center ? ['center'] : []),
  ];
}

function RigMethod({ trackA, body, onTrack, onBody, busy, disclosed = false }: {
  disclosed?: boolean;
  trackA: boolean;
  body: string;
  onTrack: (v: boolean) => void;
  onBody: (v: string) => void;
  busy: boolean;
}) {
  const choices = (
    <fieldset className='settings-group' disabled={busy}>
      <div className='backends' role='radiogroup' aria-label={t('Rigging method')}>
        <label className={`backend ${!trackA ? 'on' : ''}`}>
          <input
            type='radio'
            name='rig-method'
            checked={!trackA}
            onChange={() => onTrack(false)}
          />
          <span className='backend-copy'>
            <span className='bname'>{t('Rig this model')}</span>
            <span className='backend-meta'>UniRig · {t('GPU required')}</span>
            <span className='inote'>
              {t('Keeps your mesh and textures. Predicts joints and how they move the surface.')}
            </span>
          </span>
        </label>
        <label className={`backend ${trackA ? 'on' : ''}`}>
          <input type='radio' name='rig-method' checked={trackA} onChange={() => onTrack(true)} />
          <span className='backend-copy'>
            <span className='bname'>{t('Fit a template body')}</span>
            <span className='backend-meta'>{t('CPU only')}</span>
            <span className='inote'>
              {t('Replaces the generated geometry with a fitted body that already has a rig.')}
            </span>
          </span>
        </label>
      </div>
      {trackA && (
        <details className='panel-disclosure'>
          <summary>{t('Template body')}</summary>
          <label className='rig-field'>
            {t('Body bundle')}
            <input
              className='rootinput'
              value={body}
              onChange={(e) => onBody(e.target.value)}
              spellCheck={false}
            />
          </label>
        </details>
      )}
      <details className='panel-disclosure'>
        <summary>{t('About these methods')}</summary>
        <p className='inote'>
          {t(
            'CLI Track B is UniRig. Track A fits the bundled body. Both need inspection before acceptance.',
          )}
        </p>
      </details>
    </fieldset>
  );
  return (
    <section className='gensec rig-method'>
      <h2 className='hud'>{disclosed ? t('Rebuild method') : t('Rigging method')}</h2>
      {disclosed
        ? (
          <details className='rig-method-disclosure'>
            <summary>
              <span className='bname'>
                {trackA ? t('Fit a template body') : t('Rig this model')}
              </span>
              <span className='inote'>{trackA ? t('CPU only') : 'UniRig'}</span>
            </summary>
            {choices}
          </details>
        )
        : choices}
    </section>
  );
}

function Orientation({ draft, onChange, busy }: {
  draft: OrientationDraft;
  onChange: (v: OrientationDraft) => void;
  busy: boolean;
}) {
  return (
    <fieldset className='settings-group rig-orientation' disabled={busy}>
      <label className='rig-field'>
        {t('Model facing')}
        <select value={draft.front} onChange={(e) => onChange({ ...draft, front: e.target.value })}>
          <option value='keep'>{t('Keep current direction')}</option>
          <option value='detect'>{t('Detect front when rebuilding')}</option>
          <option value='90'>{t('Turn')} 90°</option>
          <option value='180'>{t('Turn')} 180°</option>
          <option value='270'>{t('Turn')} 270°</option>
        </select>
      </label>
      <div className='rig-checks'>
        <label className='check-field'>
          <input
            type='checkbox'
            checked={draft.upright}
            onChange={(e) => onChange({ ...draft, upright: e.target.checked })}
          />
          {t('Stand model upright')}
        </label>
        <label className='check-field'>
          <input
            type='checkbox'
            checked={draft.ground}
            onChange={(e) => onChange({ ...draft, ground: e.target.checked })}
          />
          {t('Place feet on the ground')}
        </label>
        <label className='check-field'>
          <input
            type='checkbox'
            checked={draft.center}
            onChange={(e) => onChange({ ...draft, center: e.target.checked })}
          />
          {t('Center the model')}
        </label>
      </div>
      <p className='inote'>
        {t(
          'Upright corrects a lean. Ground and center change position. Front, Side and Rear only move the camera.',
        )}
      </p>
    </fieldset>
  );
}

function RunRig(
  { bridge, dir, onChanged }: { bridge: StudioBridge; dir: string; onChanged: () => void },
) {
  const [trackA, setTrackA] = useState(false);
  const [body, setBody] = useState(BUNDLED_BODY);
  const [orientation, setOrientation] = useState(INITIAL_ORIENTATION);
  const { run, failure, canceled, exec } = useRigRun(bridge, onChanged);
  const args = rigRunArgs(
    dir,
    trackA ? { trackA: true, bodyDir: body } : { fixes: orientationFixes(orientation) },
  );
  const busy = run?.running === true;
  return (
    <div className='rigstage rig-setup'>
      <div className='rigcols'>
        <div className='rigside asset-workspace'>
          <section className='gensec'>
            <Viewport
              bridge={bridge}
              meshPath={`${dir}/canonical/model.glb`}
              previewYaw={trackA ? 0 : Number(orientation.front) || 0}
            />
          </section>
        </div>
        <Inspector className='rigmain'>
          <div className='rig-controls'>
            <RigMethod
              trackA={trackA}
              body={body}
              onTrack={setTrackA}
              onBody={setBody}
              busy={busy}
            />
            {!trackA && (
              <section className='gensec'>
                <h2 className='hud'>{t('Orientation')}</h2>
                <Orientation draft={orientation} onChange={setOrientation} busy={busy} />
              </section>
            )}
          </div>
          <section className='gensec action-section'>
            <button
              type='button'
              className='btn primary'
              aria-busy={busy}
              onClick={() => exec(args)}
            >
              {busy ? t('Rigging…') : t('Build rig')}
            </button>
            {busy && <JobActivity progress={run.progress} verb='rig' />}
            {failure && <FailureNote failure={failure} />}
            {canceled && <p className='inote job-canceled' role='status'>{t('Job canceled')}</p>}
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

function flagLabel(flag: string): string {
  if (flag === 'excessive-stretch') return t('Surface stretches in test');
  if (flag === 'no-influence') return t('No surface attached');
  if (flag === 'dead-joint') return t('Little surface movement');
  return flag;
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
        ({view.poses.join(', ')}) · {view.cleanCount} {t('not flagged by these tests')}
      </div>
      <table className='rigtable'>
        <thead>
          <tr>
            <th scope='col'>{t('joint')}</th>
            <th scope='col'>{t('finding')}</th>
            <th scope='col' className='num'>{t('Edges stretched')}</th>
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
                {j.flags.map((f) => (
                  <span key={f} title={f} className={`mbadge ${flagClass(f)}`}>{flagLabel(f)}</span>
                ))}
                {j.spannedComponents > 1 && (
                  <span
                    className='inote'
                    title={t(
                      'Separate surfaces can include clothing or accessories; this alone does not mean the rig is broken.',
                    )}
                  >
                    {j.spannedComponents} {t('mesh parts')}
                  </span>
                )}
              </td>
              <td className='mono num'>
                <div title={`${j.stretchedEdges} / ${j.influencedEdges}`}>
                  {j.influencedEdges > 0
                    ? `${(100 * j.stretchedEdges / j.influencedEdges).toFixed(1)}%`
                    : '—'}
                </div>
                <span className='inote'>
                  {t('Worst edge')} {j.maxEdgeStretch > 0 ? `×${j.maxEdgeStretch.toFixed(2)}` : '—'}
                </span>
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

function MotionReview({ bridge, dir, busy, running, onPreview }: {
  bridge: StudioBridge;
  dir: string;
  busy: boolean;
  running: boolean;
  onPreview: (args: string[], path: string) => Promise<void>;
}) {
  const { clips, error } = useClipLibrary(bridge);
  const [clipId, setClipId] = useState('');
  const selected = clips?.find((clip) => clip.id === clipId) ?? clips?.[0];
  const args = selected ? animPreviewArgs(dir, selected.id) : null;
  return (
    <section className='gensec rig-motion-review'>
      <div className='rig-posebar'>
        <label className='rig-motion-clip'>
          {t('Motion check')}
          <select
            value={selected?.id ?? ''}
            disabled={busy || !selected}
            onChange={(e) => setClipId(e.target.value)}
          >
            {!selected && (
              <option value=''>
                {clips === null && !error ? t('Loading clips…') : t('No clips available')}
              </option>
            )}
            {(clips ?? []).map((clip) => <option key={clip.id} value={clip.id}>{clip.id}</option>)}
          </select>
        </label>
        <button
          type='button'
          className='btn mbtn'
          aria-busy={running}
          disabled={!args || busy && !running}
          onClick={async () => {
            if (!busy && args && selected) {
              await onPreview(args, `${dir}/anim/preview-${selected.id}.glb`);
            }
          }}
        >
          {t('Preview motion')}
        </button>
      </div>
      <p className='inote'>
        {t(
          'Review hands and clothing in motion before accepting. Previewing does not enable the clip.',
        )}
      </p>
      {error && <p className='inote' role='status'>{error}</p>}
      {args && <CliTwin args={args} />}
    </section>
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
    | { track?: string; accepted?: boolean; jointCount?: number; orientationFixes?: string[] }
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
  const [revision, setRevision] = useState(0);
  const [orientation, setOrientation] = useState(REST_ORIENTATION);
  const [previewState, setPreviewState] = useState<{ path: string; args: string[] } | null>(null);
  const preview = previewState !== null;
  const [previewRevision, setPreviewRevision] = useState(0);
  const rerunOpts = rerunTrackA
    ? { trackA: true as const, bodyDir: rerunBody }
    : { fixes: orientationFixes(orientation) };
  const changed = useCallback((args: string[]) => {
    if (args.includes('--preview') || args.includes('--preview-joint')) return;
    if (
      !args.includes('--accept') && !args.includes('--unaccept')
    ) {
      setRevision((n) => n + 1);
      setOrientation(REST_ORIENTATION);
      setPreviewState(null);
      setEdits([]);
    }
    onChanged();
  }, [onChanged]);
  const { run, failure, canceled, exec } = useRigRun(bridge, changed);
  const flaggedJoints = useMemo(() => report?.flagged.map((j) => j.joint) ?? [], [report]);
  const readRigReport = bridge.readRigReport;

  // the first successful run unmounts RunRig under the focused button — land
  // on the deform report that replaced it
  useLandFocus(rig !== undefined, '.rigdeform');
  // applying or discarding the pending edits unmounts the edits block under
  // the focused button — land on the repair verbs, where the next act lives
  useLandFocus(edits.length === 0, '.rigrerun');

  useEffect(() => {
    let live = true;
    setReport(null);
    readRigReport(dir).then(
      (r) => live && setReport(projectReport(r)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [readRigReport, dir, rig?.accepted, revision]);

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
            <div className='rig-posebar'>
              <button
                type='button'
                className='btn mbtn'
                disabled={!selectedJoint || busy || edits.length > 0}
                onClick={async () => {
                  if (
                    selectedJoint &&
                    await exec(['rig', '--workspace', dir, '--preview-joint', selectedJoint]) === 0
                  ) {
                    setPreviewRevision((n) => n + 1);
                    setPreviewState({
                      path: `${dir}/rig/deform-preview.glb`,
                      args: ['rig', '--workspace', dir, '--preview-joint', selectedJoint],
                    });
                  }
                }}
              >
                {t('Preview selected joint bend')}
              </button>
              {preview && (
                <button
                  type='button'
                  className='btn mbtn'
                  onClick={() => setPreviewState(null)}
                >
                  {t('Return to rest pose')}
                </button>
              )}
            </div>
            <div className='gensechead'>
              <span className='inote'>
                {preview || rig.track === 'A'
                  ? t('Select a joint or a report finding to inspect its bend.')
                  : t('Click a joint to inspect it. Drag the move handles to draft an edit.')}
              </span>
            </div>
            <Viewport
              bridge={bridge}
              meshPath={previewState?.path ?? `${dir}/canonical/model.glb`}
              contentKey={`${
                (m.canonicalMesh as { gltfSha256?: string } | undefined)?.gltfSha256 ?? ''
              }:${preview ? previewRevision : 0}`}
              focusJoint={focusJoint}
              showSkeleton
              flaggedJoints={flaggedJoints}
              previewYaw={preview || rerunTrackA ? 0 : Number(orientation.front) || 0}
              onNudge={preview || rig.track === 'A'
                ? undefined
                : (e) =>
                  setEdits((cur) =>
                    mergeEdits(cur, {
                      joint: e.joint,
                      delta: e.delta,
                      mirrored: mirror,
                    })
                  )}
              onJointSelected={setSelectedJoint}
            />
            {previewState && <CliTwin args={previewState.args} />}
            {selectedJoint && !preview && rig.track !== 'A' && (
              <div className='genrow'>
                <label className='bindhold'>
                  <input
                    type='checkbox'
                    disabled={preview || rig.track === 'A'}
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
            )}
            <p className='inote'>
              {t('Blue: no warning · amber: review surface movement · white: selected')}
            </p>
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
              <span className='hud'>{t('Bend checks')}</span>
            </div>
            <p className='inote'>
              {t(
                'These checks bend one joint at a time. A joint can be well placed while the surface stretches around it. Select a joint, then preview its bend.',
              )}
            </p>
            {report && (
              <>
                <p className='inote'>
                  {report.totalJoints} {t('predicted joints')} · {report.namedCount}{' '}
                  {t('named joints')}
                </p>
                {report.fingerCount === 0 && (
                  <p className='inote'>
                    {t('Separate finger motion is not mapped. Hands move with the wrists.')}
                  </p>
                )}
                {(report.handBranches.left !== null || report.handBranches.right !== null) && (
                  <p className='inote'>
                    {t('Branches at each wrist')} · {t('Left hand')}:{' '}
                    {report.handBranches.left ?? '—'} · {t('Right hand')}:{' '}
                    {report.handBranches.right ?? '—'}
                  </p>
                )}
              </>
            )}
            {report === null
              ? (
                <div className='inote'>
                  {t('no deform report on disk — re-run the rig to write one')}
                </div>
              )
              : report.flagged.length === 0
              ? (
                <div className='inote'>
                  {t('No joints were flagged. Inspect the skeleton and motion before accepting.')}
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
              <JobActivity
                progress={run.progress}
                verb={run.args.includes('--preview')
                  ? 'anim-preview'
                  : run.args.includes('--preview-joint')
                  ? 'rig-preview'
                  : 'rig'}
              />
              <CliTwin args={run.args} />
            </div>
          )}
          {failure && <FailureNote failure={failure} />}
          {canceled && <p className='inote job-canceled' role='status'>{t('Job canceled')}</p>}
          <div className='rig-controls'>
            <MotionReview
              bridge={bridge}
              dir={dir}
              busy={busy || edits.length > 0}
              running={run?.running === true && run.args.includes('--preview')}
              onPreview={async (args, path) => {
                if (await exec(args) === 0) {
                  setPreviewRevision((n) => n + 1);
                  setPreviewState({ path, args });
                }
              }}
            />
            <RigMethod
              disclosed
              trackA={rerunTrackA}
              body={rerunBody}
              onTrack={setRerunTrackA}
              onBody={setRerunBody}
              busy={busy}
            />
            {!rerunTrackA && (
              <section className='gensec'>
                <h2 className='hud'>{t('Orientation')}</h2>
                <button
                  type='button'
                  className='btn mbtn'
                  disabled={busy || preview || edits.length > 0}
                  onClick={() =>
                    exec(rigRunArgs(dir, { fixes: orientationFixes(INITIAL_ORIENTATION) }))}
                >
                  {t('Auto align and rebuild rig')}
                </button>
                <details className='panel-disclosure'>
                  <summary>{t('Adjust alignment')}</summary>
                  <Orientation
                    draft={orientation}
                    onChange={setOrientation}
                    busy={busy || preview || edits.length > 0}
                  />
                  <button
                    type='button'
                    className='btn mbtn'
                    disabled={busy || preview || edits.length > 0 ||
                      orientationFixes(orientation).length === 0}
                    onClick={() => exec(rigRunArgs(dir, { fixes: orientationFixes(orientation) }))}
                  >
                    {t('Apply orientation and rebuild rig')}
                  </button>
                  <p className='inote'>
                    {t(
                      'Rebuilds joints and weights on the GPU. The current rig is replaced; undo restores it.',
                    )}
                  </p>
                  {orientationFixes(orientation).length > 0 && (
                    <CliTwin args={rigRunArgs(dir, { fixes: orientationFixes(orientation) })} />
                  )}
                </details>
                <CliTwin args={rigRunArgs(dir, { fixes: orientationFixes(INITIAL_ORIENTATION) })} />
              </section>
            )}
            <section className='gensec'>
              <h2 className='hud'>{t('Rebuild and repair')}</h2>
              <button
                type='button'
                className='btn mbtn rigrerun'
                aria-busy={busy}
                onClick={() => exec(rigRunArgs(dir, rerunOpts))}
              >
                {t('Rebuild rig')}
              </button>
              <CliTwin args={rigRunArgs(dir, rerunOpts)} />
              {!rerunTrackA && (
                <details className='panel-disclosure'>
                  <summary>{t('Repair tools')}</summary>
                  <p className='inote'>
                    {t(
                      'Position hints can help misplaced joints. They cannot fix a wrong joint hierarchy or guarantee better skin weights.',
                    )}
                  </p>
                  <button
                    type='button'
                    className='btn mbtn'
                    disabled={orientationFixes(orientation).length > 0 || edits.length > 0}
                    aria-busy={busy}
                    onClick={() => exec(rigRunArgs(dir, { autoHints: true }))}
                  >
                    {t('Derive position hints and rebuild')}
                  </button>
                  <CliTwin args={rigRunArgs(dir, { autoHints: true })} />
                  <label className='rig-field'>
                    {t('Joint edits file')}
                    <input
                      className='rootinput'
                      value={editsPath}
                      onChange={(e) => setEditsPath(e.target.value)}
                      placeholder='patch.json'
                      spellCheck={false}
                    />
                  </label>
                  <div className='candacts'>
                    <button
                      type='button'
                      className='btn mbtn'
                      disabled={editsPath.length === 0 || busy}
                      onClick={() => exec(rigRunArgs(dir, { editsPath }))}
                    >
                      {t('Apply edits')}
                    </button>
                    <button
                      type='button'
                      className='btn mbtn'
                      disabled={editsPath.length === 0 || busy}
                      onClick={() => exec(rigRunArgs(dir, { editsPath, rerunWithHints: true }))}
                    >
                      {t('Re-run with edits as hints')}
                    </button>
                  </div>
                </details>
              )}
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
                  'Review flagged joints and preview the bend before accepting.',
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
