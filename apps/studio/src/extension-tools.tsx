import { useState } from 'react';
import type { ListedTool } from '@spritebook/registry';
import type { StudioBridge } from './bridge';
import { CliTwin, lastFailure } from './gen';
import { type ProgressState, readProgress } from './bakeprogress';
import { byteLabel, InstallProgress } from './install-progress';
import { useLandFocus } from './focus';
import { t } from './i18n';

function BlenderTool({ bridge, tool, busy, setBusy, refresh }: {
  bridge: StudioBridge;
  tool: ListedTool;
  busy: string | null;
  setBusy: (ref: string | null) => void;
  refresh: () => Promise<void>;
}) {
  const [path, setPath] = useState(tool.detected[0] ?? '');
  const [accepted, setAccepted] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string[] | null>(null);
  const [args, setArgs] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<{ exit: number | null; message?: string } | null>(null);
  const working = busy === tool.id;
  useLandFocus(working, '.extension-tool [aria-busy="true"]');
  useLandFocus(!working && result !== null, '.extension-tool > [role="status"]');
  const run = async (args: string[]) => {
    if (busy !== null) return;
    setBusy(tool.id);
    setArgs(args);
    setConfirmRemove(null);
    setResult(null);
    setProgress(null);
    try {
      const r = await bridge.runCli([...args, '--json'], (line) => {
        const next = readProgress(line);
        if (next) setProgress(next);
      });
      setResult({ exit: r.exitCode, message: lastFailure(r.lines)?.message });
    } catch (error) {
      setResult({ exit: 1, message: error instanceof Error ? error.message : String(error) });
    } finally {
      await refresh();
      setBusy(null);
    }
  };
  const useArgs = ['extensions', 'use', 'blender', '--path', path, '--accept-license'];
  const installArgs = ['extensions', 'install', `blender@${tool.version}`, '--accept-license'];
  const selected = tool.selected;
  return (
    <section className='mrow extension-tool' aria-label={tool.displayName}>
      <div className='model-main'>
        <div className='model-summary'>
          <h3>{tool.displayName}</h3>
          <div className='model-meta'>
            <span>{t('Optional background tool')}</span>
            <span>{tool.version} LTS</span>
          </div>
        </div>
        <span className='model-status warning'>{t('Experimental')}</span>
      </div>
      <p className='inote'>
        {t(
          'Clothing repair is still experimental. Installing Blender does not automatically fix motion.',
        )}
      </p>
      {tool.issue && <p className='model-error' role='alert'>{tool.issue}</p>}
      {tool.issue && !selected && (
        <button
          type='button'
          className='btn mbtn'
          disabled={busy !== null}
          onClick={() => setConfirmRemove(['extensions', 'rm', 'blender'])}
        >
          {t('Forget installation')}
        </button>
      )}
      {selected && (
        <div className='extension-selection'>
          <strong>
            {selected.version} ·{' '}
            {selected.mode === 'external' ? t('Your installation') : t('Managed by SpriteBook')}
          </strong>
          <p className='mono extension-path'>{selected.executable}</p>
          <div className='model-actions'>
            <button
              type='button'
              className='btn mbtn'
              disabled={busy !== null}
              onClick={() => run(['extensions', 'verify', 'blender'])}
            >
              {t('Check Blender')}
            </button>
            <button
              type='button'
              className='btn mbtn'
              disabled={busy !== null}
              onClick={() => setConfirmRemove(['extensions', 'rm', 'blender'])}
            >
              {selected.mode === 'external' ? t('Forget installation') : t('Remove download')}
            </button>
          </div>
          <CliTwin args={['extensions', 'verify', 'blender']} />
        </div>
      )}
      {working && (
        <>
          <button type='button' className='btn mbtn' aria-busy='true'>{t('Working…')}</button>
          <InstallProgress progress={progress} />
          {args && <CliTwin args={args} />}
        </>
      )}
      {result && !working && (
        <div className={result.exit === 0 ? 'model-result' : 'model-error'} role='status'>
          {result.exit === 0
            ? t('Completed')
            : result.exit === 130
            ? t('Canceled')
            : t('Could not complete this action')}
          {result.message && (
            <details>
              <summary>{t('Show error')}</summary>
              <p>{result.message}</p>
            </details>
          )}
        </div>
      )}
      {confirmRemove && (
        <div className='model-confirm'>
          <p>
            {t(
              'Only SpriteBook-managed downloads are deleted. Existing installations and projects stay.',
            )}
          </p>
          <CliTwin args={confirmRemove} />
          <div className='model-actions'>
            <button
              type='button'
              className='btn mbtn danger'
              disabled={busy !== null}
              onClick={() => run(confirmRemove)}
            >
              {t('Confirm remove')}
            </button>
            <button type='button' className='btn mbtn' onClick={() => setConfirmRemove(null)}>
              {t('Back')}
            </button>
          </div>
        </div>
      )}
      <details className='model-details' open={!selected || undefined}>
        <summary>{t('Use existing Blender')}</summary>
        <p className='dimtext'>
          {t('Choose Blender 4.5 LTS. SpriteBook checks it without changing its settings.')}
        </p>
        <label className='field extension-file'>
          <span>{t('Blender executable')}</span>
          <input
            className='rootinput'
            value={path}
            list='blender-detected'
            placeholder={t('Full path to Blender')}
            disabled={busy !== null}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <datalist id='blender-detected'>
          {tool.detected.map((p) => <option key={p} value={p} />)}
        </datalist>
        <label className='model-accept'>
          <input
            type='checkbox'
            checked={accepted}
            disabled={busy !== null}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>
            {t('I accept the license')}:{' '}
            <a href={tool.license.url} target='_blank' rel='noreferrer'>{tool.license.spdx}</a>
          </span>
        </label>
        <button
          type='button'
          className='btn mbtn primary'
          disabled={busy !== null || !path.trim() || !accepted}
          onClick={() => run(useArgs)}
        >
          {t('Check and use Blender')}
        </button>
        {path.trim() && <CliTwin args={useArgs} />}
      </details>
      <details className='model-details'>
        <summary>{t('Download portable Blender')}</summary>
        {tool.download
          ? (
            <>
              <dl>
                <dt>{t('Download')}</dt>
                <dd>{byteLabel(tool.download.archive.bytes)}</dd>
                <dt>{t('Installed size')}</dt>
                <dd>{byteLabel(tool.download.expandedBytes)}</dd>
                <dt>{t('Setup space')}</dt>
                <dd>{byteLabel(tool.download.requiredDiskBytes)}</dd>
              </dl>
              <p className='dimtext'>
                {t(
                  'Separate download. No system installation or file associations. Temporary repair files need extra space.',
                )}
              </p>
              <label className='model-accept'>
                <input
                  type='checkbox'
                  checked={accepted}
                  disabled={busy !== null}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>
                  {t('I accept the license')}:{' '}
                  <a href={tool.license.url} target='_blank' rel='noreferrer'>
                    {tool.license.spdx}
                  </a>
                </span>
              </label>
              <button
                type='button'
                className='btn mbtn primary'
                disabled={busy !== null || !accepted ||
                  tool.managed.some((m) => m.version === tool.version)}
                onClick={() => run(installArgs)}
              >
                {t('Download Blender')}
              </button>
              <CliTwin args={installArgs} />
            </>
          )
          : (
            <p>
              {t(
                'Managed downloads are available on Windows x64. You can select an existing Blender 4.5 LTS installation; other platforms remain unqualified.',
              )}
            </p>
          )}
        <p>
          <a href={tool.sourceUrl} target='_blank' rel='noreferrer'>{t('Blender source code')}</a>
        </p>
      </details>
      {tool.managed.length > 0 && (
        <details className='model-details'>
          <summary>{t('Downloaded copies')}</summary>
          {tool.managed.map((copy) => (
            <div className='extension-copy' key={copy.version}>
              <span>{copy.version}</span>
              <div className='model-actions'>
                <button
                  type='button'
                  className='btn mbtn'
                  disabled={busy !== null}
                  onClick={() =>
                    run(['extensions', 'use', `blender@${copy.version}`, '--accept-license'])}
                >
                  {t('Use this copy')}
                </button>
                <button
                  type='button'
                  className='btn mbtn'
                  disabled={busy !== null}
                  onClick={() => setConfirmRemove(['extensions', 'rm', `blender@${copy.version}`])}
                >
                  {t('Remove download')}
                </button>
              </div>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

export function ExtensionTools(props: {
  bridge: StudioBridge;
  tools: ListedTool[];
  busy: string | null;
  setBusy: (ref: string | null) => void;
  refresh: () => Promise<void>;
}) {
  return props.tools.map((tool) => <BlenderTool {...props} tool={tool} key={tool.id} />);
}
