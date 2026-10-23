import { useEffect, useState } from 'react';
import type { ProgressState } from './bakeprogress';
import { t } from './i18n';

/** Stage units have different costs; show elapsed time without inventing a job percentage. */
export function JobActivity({ progress, verb }: { progress: ProgressState | null; verb: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const step = progress?.step ?? '';
  const phase = step.startsWith('prepare image')
    ? t('Preparing source image')
    : step === 'backend:load'
    ? t('Loading generator')
    : step.startsWith('backend:generate') || step === 'generate'
    ? t('Generating geometry')
    : step.startsWith('backend:encode')
    ? t('Encoding model')
    : step.startsWith('border')
    ? t('Validating and importing model')
    : step === 'receipt' || step === 'record'
    ? t('Saving results')
    : step === 'facing' || step.startsWith('orient:')
    ? t('Checking orientation')
    : step === 'predict:extract'
    ? t('Preparing mesh for rigging')
    : step === 'predict:skeleton'
    ? t('Predicting skeleton')
    : step === 'predict:skin'
    ? t('Calculating skin weights')
    : step === 'predict:merge' || step === 'apply' || step === 'fit'
    ? t('Fitting rig to mesh')
    : step === 'deform' || step === 'validate'
    ? t('Checking deformation')
    : step || t('Starting…');
  const title = verb === 'rig-preview'
    ? t('Preparing joint preview')
    : verb === 'anim-preview'
    ? t('Preparing motion preview')
    : verb === 'rig'
    ? t('Rigging character')
    : verb === 'pick'
    ? t('Saving canonical mesh')
    : verb === 'retexture'
    ? t('Re-texturing model')
    : t('Generating model');
  return (
    <div className='job-activity'>
      <div className='activity-head'>
        <strong>{title}</strong>
        <span className='mono' aria-live='off'>
          {t('Elapsed')} {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
        </span>
      </div>
      <div role='status'>{phase}</div>
      <progress aria-label={title} />
      <p className='inote'>
        {verb === 'rig-preview' || verb === 'anim-preview'
          ? t('CPU only. The saved rig is unchanged.')
          : t('Timing varies with the model and settings.')}
      </p>
      {progress && (
        <details className='activity-detail'>
          <summary>{t('Stage details')}</summary>
          <code>{step} · {progress.done}/{progress.total}</code>
        </details>
      )}
    </div>
  );
}
