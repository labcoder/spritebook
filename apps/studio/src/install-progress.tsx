import type { ProgressState } from './bakeprogress';
import { t } from './i18n';

export const byteLabel = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : bytes >= 1e3
    ? `${(bytes / 1e3).toFixed(1)} KB`
    : `${bytes} B`;

export function InstallProgress({ progress }: { progress: ProgressState | null }) {
  const step = progress?.step ?? '';
  const bytes = step.includes('download-bytes:');
  const determinate = bytes || step === 'verify';
  const label = bytes
    ? t('Downloading files')
    : step === 'tool:extract'
    ? t('Extracting Blender')
    : step === 'tool:check'
    ? t('Checking Blender')
    : step.startsWith('setup:dependencies')
    ? t('Installing dependencies')
    : step.startsWith('setup:sidecar')
    ? t('Preparing the model service')
    : step.startsWith('setup:check')
    ? t('Checking the runtime')
    : step.startsWith('setup:')
    ? t('Preparing runtime files')
    : step.startsWith('download:') || step === 'verify'
    ? t('Verifying files')
    : t('Starting…');
  const dependency = step.startsWith('setup:dependencies:')
    ? step.slice('setup:dependencies:'.length)
    : '';
  const detail = bytes
    ? step.split('download-bytes:')[1]
    : /^(Downloading|Downloaded|Installing|Installed|Prepared|Resolved)\s/.test(dependency)
    ? dependency
    : step.startsWith('download:')
    ? step.slice('download:'.length)
    : '';
  return (
    <div className='model-progress'>
      <div className='model-progress-label'>
        <span role='status'>{label}</span>
        {determinate && progress && (
          <span className='mono dimtext'>
            {bytes
              ? `${byteLabel(progress.done)} / ${byteLabel(progress.total)}`
              : `${progress.done} / ${progress.total}`}
          </span>
        )}
      </div>
      <progress aria-label={label} max={1} value={determinate ? progress?.fraction : undefined} />
      {detail && <div className='model-progress-detail mono' title={detail}>{detail}</div>}
    </div>
  );
}
