import { useCallback, useEffect, useState } from 'react';
import type { MotionReview } from '@spritebook/schema';
import type { StudioBridge } from './bridge';
import { CliTwin } from './gen';
import { t } from './i18n';

export function MotionAudition({ bridge, dir, busy, running, sourceKey, resultId, run, onPlay }: {
  bridge: StudioBridge;
  dir: string;
  busy: boolean;
  running: boolean;
  sourceKey: string;
  resultId?: string;
  run: (args: string[]) => Promise<number | null>;
  onPlay: (path: string, args: string[]) => void;
}) {
  const [report, setReport] = useState<MotionReview | null>(null);
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [error, setError] = useState('');
  const [upright, setUpright] = useState(true);
  const candidate = resultId ? ['--result', resultId, ...(upright ? [] : ['--no-upright'])] : [];
  const args = ['anim', '--audition', '--workspace', dir, ...candidate];
  const read = useCallback(async () => {
    const result = await bridge.runCli([
      'anim',
      '--review',
      '--workspace',
      dir,
      ...(resultId ? ['--result', resultId] : []),
      ...(resultId && !upright ? ['--no-upright'] : []),
      '--json',
    ]);
    if (result.exitCode !== 0) {
      throw new Error(t('Could not read the motion review. Retry the audition.'));
    }
    const value = JSON.parse(result.lines.at(-1) ?? 'null');
    return value?.version === 1 ? value as MotionReview : null;
  }, [bridge, dir, resultId, upright]);
  useEffect(() => {
    let live = true;
    setReport(null);
    setImages({});
    setError('');
    read().then((value) => {
      if (live) setReport(value);
    }, (error) => {
      if (live) setError(String(error));
    });
    return () => {
      live = false;
    };
  }, [read, sourceKey]);
  useEffect(() => {
    let live = true;
    setImages({});
    if (report) {
      Promise.all(
        report.clips.map(async (clip) =>
          [clip.clipId, await bridge.readImage(clip.contact).catch(() => null)] as const
        ),
      )
        .then((entries) => {
          if (live) {
            setImages(Object.fromEntries(entries));
          }
        });
    }
    return () => {
      live = false;
    };
  }, [bridge, report]);
  return (
    <section className='motion-audition'>
      {resultId && (
        <>
          <label className='check-field'>
            <input
              type='checkbox'
              checked={upright}
              disabled={busy}
              onChange={(event) => setUpright(event.target.checked)}
            />
            {t('Stand model upright')}
          </label>
          <p className='inote'>
            {t(
              'If alignment is uncertain and the model is already upright, turn this off. A different recipe makes a separate draft rig.',
            )}
          </p>
        </>
      )}
      <button
        type='button'
        className='btn'
        disabled={busy && !running}
        aria-busy={running}
        onClick={async () => {
          if (busy) return;
          setError('');
          try {
            if (await run(args) === 0) setReport(await read());
          } catch (error) {
            setError(String(error));
          }
        }}
      >
        {resultId ? t('Build draft rig and test motion') : t('Review walk and jump')}
      </button>
      <p className='inote'>
        {resultId
          ? t(
            'One GPU rigging attempt, then four motions. Your selected mesh and rig stay unchanged. Repeating this recipe reuses its result.',
          )
          : t(
            'Four motions, four directions. Uses the current rig without enabling clips or changing your saved look.',
          )}
      </p>
      {error && <p className='mv-exit' role='alert'>{error}</p>}
      {report && (
        <div className='motion-review-results'>
          <p className='inote'>
            {t(
              'Inspect hands, clothing and landing. These samples do not certify anatomy or collision-free motion.',
            )}
          </p>
          {report.clips.map((clip) => (
            <section key={clip.clipId}>
              <div className='rig-posebar'>
                <strong className='mono'>{clip.clipId}</strong>
                <button
                  type='button'
                  className='btn mbtn'
                  disabled={busy}
                  onClick={() => onPlay(clip.preview, args)}
                >
                  {t('Play')}
                </button>
              </div>
              <div
                className='motion-review-pixels'
                tabIndex={0}
                role='region'
                aria-label={`${t('Motion samples')}: ${clip.clipId}`}
              >
                {images[clip.clipId]
                  ? (
                    <img
                      src={images[clip.clipId]!}
                      alt={t('Core-rendered motion in four directions')}
                    />
                  )
                  : (
                    <p className='inote'>
                      {t('Motion image unavailable. Use Play to inspect the model.')}
                    </p>
                  )}
              </div>
              <p
                className={`inote ${
                  clip.stats.worstStretchedFraction >= .01 || clip.stats.maxSeparationM > .001
                    ? 'mv-warn'
                    : ''
                }`}
              >
                {(clip.stats.worstStretchedFraction * 100).toFixed(1)}%{' '}
                {t('edges double in length at the worst sampled pose')}
                {clip.stats.maxSeparationM > .001 && (
                  <>
                    · {t('Coincident vertices separate')}:{' '}
                    {(clip.stats.maxSeparationM * 1000).toFixed(1)} mm
                  </>
                )}
              </p>
              {clip.stats.reviewJoints.length > 0 && (
                <p className='inote mono'>
                  {t('Areas to inspect')}: {clip.stats.reviewJoints.join(', ')}
                </p>
              )}
            </section>
          ))}
          {report.flags.length > 0 && (
            <p className='mv-warn'>{t('Render warnings')}: {report.flags.join(', ')}</p>
          )}
        </div>
      )}
      <CliTwin args={args} />
    </section>
  );
}
