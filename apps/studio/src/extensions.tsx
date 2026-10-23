import { discoverableModels } from './genmodels';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ListedModel, ListedTool, ListedVersion } from '@spritebook/registry';
import type { StudioBridge } from './bridge';
import { useJobBridge } from './jobscope';
import { Modal } from './modal';
import { CliTwin, lastFailure } from './gen';
import { type ProgressState, readProgress } from './bakeprogress';
import { t } from './i18n';
import { modelsArgs } from './args';
import { useLandFocus } from './focus';
import { InstallProgress } from './install-progress';
import { ExtensionTools } from './extension-tools';

type Action = 'install' | 'setup' | 'verify' | 'rm';
const gb = (bytes: number) => (bytes / 1e9).toFixed(2);

function VersionRow({ bridge, model, v, busy, setBusy, refresh, historical = false }: {
  bridge: StudioBridge;
  model: ListedModel;
  v: ListedVersion;
  busy: string | null;
  setBusy: (ref: string | null) => void;
  refresh: () => Promise<void>;
  historical?: boolean;
}) {
  const ref = `${model.id}@${v.version}`;
  const [accepted, setAccepted] = useState(false);
  const [confirming, setConfirming] = useState<Exclude<Action, 'verify'> | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<{ exit: number | null; message?: string } | null>(null);
  const isBusy = busy === ref;
  useLandFocus(isBusy, `[data-model-ref="${ref}"] [aria-busy="true"]`);
  useLandFocus(!isBusy && result !== null, `[data-model-ref="${ref}"] > [role="status"]`);
  const blocked = busy !== null && !isBusy;
  const supported = v.platformSupported !== false;
  const needsSetup = v.installed && v.runtime && !v.runtimePrepared;
  const status = !supported
    ? t('Unavailable on this machine')
    : !v.installed
    ? t('Not downloaded')
    : needsSetup
    ? t('Runtime setup required')
    : v.runtimePrepared
    ? t('Ready')
    : t('Weights downloaded');
  const run = async (next: Action) => {
    if (busy !== null) return;
    setBusy(ref);
    setAction(next);
    setConfirming(null);
    setProgress(null);
    setResult(null);
    try {
      const r = await bridge.runCli([...modelsArgs(next, ref, accepted), '--json'], (line) => {
        const p = readProgress(line);
        if (p) setProgress(p);
      });
      setResult({ exit: r.exitCode, message: lastFailure(r.lines)?.message });
    } finally {
      await refresh();
      setBusy(null);
    }
  };
  return (
    <div className='model-version' data-model-ref={ref}>
      <div className='model-main'>
        <div className='model-summary'>
          {historical ? <h4 className='mono'>{v.version}</h4> : <h3>{model.displayName}</h3>}
          <div className='model-meta'>
            <span>{gb(v.diskBytes)} GB {t('model files')}</span>
            {v.minVramGb !== undefined && (
              <span>
                {v.vramProfiles ? t('VRAM varies by settings') : `${v.minVramGb} GiB VRAM`}
              </span>
            )}
            {historical && !v.runtime && <span>{t('Manual runtime setup')}</span>}
          </div>
        </div>
        <div className='model-state'>
          <span className={needsSetup ? 'model-status warning' : 'model-status'}>{status}</span>
          {isBusy
            ? <button type='button' className='btn mbtn' aria-busy='true'>{t('Working…')}</button>
            : !v.installed
            ? (
              <button
                type='button'
                className='btn mbtn primary'
                disabled={blocked || !supported}
                onClick={() => setConfirming('install')}
              >
                {t('Install')}
              </button>
            )
            : needsSetup
            ? (
              <button
                type='button'
                className='btn mbtn primary'
                disabled={blocked || !supported}
                onClick={() => setConfirming('setup')}
              >
                {t('Set up runtime')}
              </button>
            )
            : null}
        </div>
      </div>
      {isBusy && <InstallProgress progress={progress} />}
      {isBusy && action && <CliTwin args={modelsArgs(action, ref, accepted)} />}
      {confirming && !isBusy && (
        <div className='model-confirm'>
          <p>
            {confirming === 'rm'
              ? t('Remove model files? Projects and generated assets stay.')
              : confirming === 'setup'
              ? t('Set up the runtime using the downloaded model files.')
              : `${t('Download model files:')} ${gb(v.diskBytes)} GB`}
          </p>
          {confirming !== 'rm' && v.runtime && (
            <p className='dimtext'>
              {t('Runtime setup also downloads code and Python dependencies.')}
            </p>
          )}
          {confirming !== 'rm' && model.license.requiresAcceptance && (
            <label className='model-accept'>
              <input
                type='checkbox'
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                {t('I accept the license')}: {model.license.name}{' '}
                {model.license.url && (
                  <a href={model.license.url} target='_blank' rel='noreferrer'>
                    {t('Read license')}
                  </a>
                )}
              </span>
            </label>
          )}
          <CliTwin args={modelsArgs(confirming, ref, accepted)} />
          <div className='model-actions'>
            <button
              type='button'
              className={`btn mbtn ${confirming === 'rm' ? 'danger' : 'primary'}`}
              disabled={blocked ||
                (confirming !== 'rm' && model.license.requiresAcceptance && !accepted)}
              onClick={() => run(confirming)}
            >
              {confirming === 'rm'
                ? t('Confirm remove')
                : confirming === 'setup'
                ? t('Confirm runtime setup')
                : t('Confirm download')}
            </button>
            <button type='button' className='btn mbtn' onClick={() => setConfirming(null)}>
              {t('Back')}
            </button>
          </div>
        </div>
      )}
      {result && !isBusy && (
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
      <details className='model-details'>
        <summary>{t('Details')}</summary>
        <dl>
          <dt>{t('Build')}</dt>
          <dd className='mono'>{ref}</dd>
          <dt>{t('Platforms')}</dt>
          <dd>{v.platforms.join(', ')}</dd>
          <dt>{t('License')}</dt>
          <dd>{model.license.spdx ?? model.license.name}</dd>
          {v.runtime && (
            <>
              <dt>{t('Runtime')}</dt>
              <dd>{v.runtimePrepared ? t('Prepared') : t('Setup required')}</dd>
            </>
          )}
        </dl>
        {v.notes && <p className='dimtext'>{v.notes}</p>}
        {v.installed && (
          <>
            <div className='model-actions'>
              <button
                type='button'
                className='btn mbtn'
                disabled={busy !== null}
                onClick={() => run('verify')}
              >
                {t('Verify files')}
              </button>
              {v.runtime && (
                <button
                  type='button'
                  className='btn mbtn'
                  disabled={busy !== null || !supported}
                  onClick={() => setConfirming('setup')}
                >
                  {t('Repair runtime')}
                </button>
              )}
              <button
                type='button'
                className='btn mbtn danger'
                disabled={busy !== null}
                onClick={() => setConfirming('rm')}
              >
                {t('Remove')}
              </button>
            </div>
            <CliTwin args={modelsArgs('verify', ref, false)} />
          </>
        )}
      </details>
    </div>
  );
}

function ExtensionsDialog(
  { bridge: baseBridge, open, onClose }: {
    bridge: StudioBridge;
    open: boolean;
    onClose: () => void;
  },
) {
  const { bridge, cancel } = useJobBridge(baseBridge, String(open));
  const [rows, setRows] = useState<ListedModel[] | null>(null);
  const [tools, setTools] = useState<ListedTool[]>([]);
  const [content, setContent] = useState<
    { id: string; displayName: string; kind: string; license?: string; clipCount?: number }[]
  >([]);
  const [section, setSection] = useState<'models' | 'tools' | 'content'>('models');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setError(null);
    const r = await bridge.runCli(['extensions', 'list', '--json']);
    if (r.exitCode !== 0 || !r.lines.length) {
      setError(t('Could not load extensions. Check the log, then refresh.'));
      return;
    }
    try {
      const doc = JSON.parse(r.lines.at(-1)!);
      setRows(discoverableModels(doc.models ?? [], import.meta.env.DEV));
      setTools(doc.tools ?? []);
      setContent(doc.content ?? []);
    } catch {
      setError(t('catalog output was not JSON'));
    }
  }, [bridge]);
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);
  const installedBytes = useMemo(
    () =>
      (rows ?? []).flatMap((m) => m.versions).filter((v) => v.installed).reduce(
        (sum, v) => sum + v.diskBytes,
        0,
      ),
    [rows],
  );
  return (
    <Modal open={open} onClose={onClose} label={t('Manage extensions')} className='mdl'>
      <div className='mdl-head'>
        <div>
          <h2>{t('Manage extensions')}</h2>
          <p className='dimtext'>{t('Install only what you need.')}</p>
        </div>
        <div className='model-actions'>
          {busy && (
            <button type='button' className='btn mbtn' onClick={cancel} title='CLI: Ctrl+C'>
              {t('Cancel job')}
            </button>
          )}
          <button type='button' className='btn mbtn' onClick={refresh} disabled={busy !== null}>
            {t('Refresh')}
          </button>
          <button type='button' className='btn mbtn' onClick={onClose}>{t('Close')}</button>
        </div>
      </div>
      <nav className='extension-nav' aria-label={t('Extension categories')}>
        {(['models', 'tools', 'content'] as const).map((id) => (
          <button
            type='button'
            key={id}
            aria-pressed={section === id}
            disabled={busy !== null}
            onClick={() => setSection(id)}
          >
            {id === 'models' ? t('Models') : id === 'tools' ? t('Tools') : t('Content')}
          </button>
        ))}
      </nav>
      <div
        className='mdl-body'
        tabIndex={0}
        role='region'
        aria-label={section === 'models'
          ? t('Models')
          : section === 'tools'
          ? t('Tools')
          : t('Content')}
      >
        {error && <p className='mdl-error' role='alert'>{error}</p>}
        {rows === null && !error && (
          <p className='mdl-loading' role='status'>{t('Loading extensions…')}</p>
        )}
        {section === 'models' && (
          <p className='extension-summary'>{gb(installedBytes)} GB {t('model files downloaded')}</p>
        )}
        {section === 'models' && rows?.length === 0 && (
          <p className='mdl-loading'>{t('No models in this catalog.')}</p>
        )}
        {section === 'models' && rows?.map((m) => {
          const recommended = m.versions.find((v) => v.version === m.recommendedVersion) ??
            m.versions.at(-1);
          if (!recommended) return null;
          const others = m.versions.filter((v) => v !== recommended);
          return (
            <section key={m.id} className='mrow' aria-label={m.displayName}>
              <VersionRow
                bridge={bridge}
                model={m}
                v={recommended}
                busy={busy}
                setBusy={setBusy}
                refresh={refresh}
              />
              {(m.license.excludedTerritories?.length ?? 0) > 0 && (
                <p className='model-restriction'>
                  {t('not available in')}: {m.license.excludedTerritories!.join(', ')}
                </p>
              )}
              {others.length > 0 && (
                <details className='model-others'>
                  <summary>
                    {t('Other versions')} ({others.length}){others.some((v) => v.installed)
                      ? ` · ${t('older files downloaded')}`
                      : ''}
                  </summary>
                  <p className='dimtext'>
                    {t(
                      'The recommended build includes managed setup. Older builds remain for existing projects.',
                    )}
                  </p>
                  {others.map((v) => (
                    <VersionRow
                      key={v.version}
                      bridge={bridge}
                      model={m}
                      v={v}
                      historical
                      busy={busy}
                      setBusy={setBusy}
                      refresh={refresh}
                    />
                  ))}
                </details>
              )}
            </section>
          );
        })}
        {section === 'tools' && (
          <ExtensionTools
            bridge={bridge}
            tools={tools}
            busy={busy}
            setBusy={setBusy}
            refresh={refresh}
          />
        )}
        {section === 'content' &&
          content.map((item) => (
            <section className='mrow' key={`${item.kind}:${item.id}`}>
              <div className='model-main'>
                <div className='model-summary'>
                  <h3>{item.displayName}</h3>
                  <div className='model-meta'>
                    <span>
                      {item.kind === 'animation-pack' ? t('Animation pack') : t('Style preset')}
                    </span>
                    {item.clipCount !== undefined && <span>{item.clipCount} {t('clips')}</span>}
                    {item.license && <span>{item.license}</span>}
                  </div>
                </div>
                <span className='model-status'>{t('Included')}</span>
              </div>
            </section>
          ))}
      </div>
    </Modal>
  );
}

export function ManageExtensions(
  props: { bridge: StudioBridge; open: boolean; onClose: () => void },
) {
  return props.open ? <ExtensionsDialog {...props} /> : null;
}
