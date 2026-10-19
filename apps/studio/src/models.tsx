import { useJobBridge } from './jobscope';
/**
 * Manage models (⌘M): the registry projected, with its gates VISIBLE —
 * license (SPDX + acceptance requirement), territory exclusions, VRAM floor,
 * disk cost. Actions wrap the registry verbs verbatim: install carries
 * --accept-license only when the user ticks the box (the CLI enforces the
 * gate either way — the GUI never bypasses, it only makes the gate legible),
 * and every action shows its CLI twin. Streams land in the log drawer.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from './modal';
import type { StudioBridge } from './bridge';
import { t } from './i18n';
import { modelsArgs } from './args';

interface ModelVersion {
  version: string;
  diskBytes: number;
  platforms: string[];
  minVramGb?: number;
  installed: boolean;
}

interface ModelRow {
  id: string;
  kind: string;
  displayName: string;
  license: {
    name: string;
    spdx?: string;
    requiresAcceptance?: boolean;
    excludedTerritories?: string[];
  };
  versions: ModelVersion[];
}

function gb(bytes: number): string {
  return bytes === 0 ? '0' : (bytes / 1e9).toFixed(2);
}

export function cliTwin(
  action: 'install' | 'verify' | 'rm',
  ref: string,
  acceptLicense: boolean,
): string {
  return `spritebook ${modelsArgs(action, ref, acceptLicense).join(' ')}`;
}

function VersionRow({ bridge, model, v, busy, setBusy, refresh }: {
  bridge: StudioBridge;
  model: ModelRow;
  v: ModelVersion;
  busy: string | null;
  setBusy: (b: string | null) => void;
  refresh: () => void;
}) {
  const ref = `${model.id}@${v.version}`;
  const needsAcceptance = model.license.requiresAcceptance === true;
  const [accepted, setAccepted] = useState(false);
  const [confirming, setConfirming] = useState<'install' | 'rm' | null>(null);
  const [lastExit, setLastExit] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState<
    { label: string; done: number; total: number } | null
  >(null);

  const runAction = useCallback(async (action: 'install' | 'verify' | 'rm') => {
    setBusy(ref);
    setConfirming(null);
    setProgress(null);
    const args = ['models', action, ref, '--json'];
    if (action === 'install' && accepted) args.push('--accept-license');
    // the install streams one progress event per file (step download:<name>);
    // a 22-file 16 GB run must read as MOTION, not a frozen dialog - the UX
    // pass installed blind and had only the raw drawer to guess from
    const r = await bridge.runCli(args, (line) => {
      try {
        const e = JSON.parse(line);
        if (e.t === 'progress' && typeof e.step === 'string') {
          setProgress({
            label: e.step.startsWith('download:') ? e.step.slice('download:'.length) : e.step,
            done: Number(e.done ?? 0),
            total: Number(e.total ?? 0),
          });
        }
      } catch { /* non-JSON lines stay the drawer's business */ }
    });
    setLastExit(r.exitCode);
    setProgress(null);
    setBusy(null);
    refresh();
  }, [bridge, ref, accepted, setBusy, refresh]);

  const pendingTwin = cliTwin(confirming ?? 'verify', ref, accepted);
  const isBusy = busy === ref;

  return (
    <div className='mv'>
      <span className='mono mv-ver'>{v.version}</span>
      <span className='mono mv-size'>{gb(v.diskBytes)} GB</span>
      {v.minVramGb !== undefined && <span className='mono mv-vram'>≥{v.minVramGb} GiB VRAM</span>}
      <span className='mono mv-plat' title={v.platforms.join(', ')}>
        {v.platforms.length} {t('platforms')}
      </span>
      {v.installed
        ? <span className='mbadge ok'>{t('installed')}</span>
        : <span className='mbadge'>{t('not installed')}</span>}
      <span className='mv-actions'>
        {v.installed && (
          <button
            type='button'
            className='btn mbtn'
            disabled={busy !== null}
            onClick={() => runAction('verify')}
          >
            {isBusy ? t('Working…') : t('Verify')}
          </button>
        )}
        {v.installed && (confirming === 'rm'
          ? (
            <button
              type='button'
              className='btn mbtn danger'
              disabled={busy !== null}
              onClick={() => runAction('rm')}
            >
              {t('Confirm remove')}
            </button>
          )
          : (
            <button
              type='button'
              className='btn mbtn'
              disabled={busy !== null}
              onClick={() => setConfirming('rm')}
            >
              {t('Remove')}
            </button>
          ))}
        {!v.installed && (confirming === 'install'
          ? (
            <button
              type='button'
              className='btn mbtn primaryish'
              disabled={busy !== null || (needsAcceptance && !accepted)}
              onClick={() => runAction('install')}
            >
              {t('Confirm download')} {gb(v.diskBytes)} GB
            </button>
          )
          : (
            <button
              type='button'
              className='btn mbtn'
              disabled={busy !== null}
              onClick={() => setConfirming('install')}
            >
              {t('Install')}
            </button>
          ))}
      </span>
      {isBusy && progress !== null && progress.total > 0 && (
        <span className='mv-progress' role='status'>
          <span className='mv-bar' aria-hidden='true'>
            <span
              className='mv-barfill'
              style={{
                width: `${Math.round((progress.done / progress.total) * 100)}%`,
              }}
            />
          </span>
          <span className='mono dimtext'>
            {progress.done}/{progress.total} · {progress.label}
          </span>
        </span>
      )}
      {confirming === 'install' && needsAcceptance && (
        <label className='mv-accept'>
          <input
            type='checkbox'
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          {t('I accept the license')}: {model.license.name}
        </label>
      )}
      {confirming && (
        <span className='mv-twin mono'>
          <span className='mv-twincmd'>$ {pendingTwin}</span>
          <button
            type='button'
            className='btn mbtn'
            onClick={() => {
              navigator.clipboard.writeText(pendingTwin).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }, () => {});
            }}
          >
            {copied ? t('Copied') : t('Copy')}
          </button>
        </span>
      )}
      {lastExit !== null && lastExit !== 0 && (
        <span className='mv-exit mono'>
          {t('failed — the log drawer has the verbatim reason')}
        </span>
      )}
    </div>
  );
}

export function ManageModels({ bridge: baseBridge, open, onClose }: {
  bridge: StudioBridge;
  open: boolean;
  onClose: () => void;
}) {
  const { bridge, busy: jobBusy, cancel } = useJobBridge(
    baseBridge,
    String(open),
  );
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const r = await bridge.runCli(['models', 'list', '--json']);
    if (r.exitCode !== 0 || r.lines.length === 0) {
      setError(
        t('could not read the catalog — the log drawer has the verbatim reason'),
      );
      setRows(null);
      return;
    }
    try {
      const doc = JSON.parse(r.lines.at(-1)!);
      setRows((doc.models ?? []) as ModelRow[]);
    } catch {
      setError(t('catalog output was not JSON'));
      setRows(null);
    }
  }, [bridge]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const installedBytes = useMemo(
    () =>
      (rows ?? []).flatMap((m) => m.versions).filter((v) => v.installed)
        .reduce((a, v) => a + v.diskBytes, 0),
    [rows],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      label={t('Manage models')}
      className='mdl'
    >
      <div className='mdl-head'>
        {jobBusy && (
          <button
            type='button'
            className='btn'
            onClick={cancel}
            title='CLI: Ctrl+C'
          >
            {t('Cancel job')} <kbd>Ctrl+C</kbd>
          </button>
        )}
        <span className='hud'>{t('Manage models')}</span>
        <span className='mono dimtext'>
          {t('installed')}: {gb(installedBytes)} GB
        </span>
        <button
          type='button'
          className='btn mbtn'
          onClick={refresh}
          disabled={busy !== null}
        >
          {t('Refresh')}
        </button>
        <button type='button' className='btn mbtn' onClick={onClose}>
          {t('Close')}
        </button>
      </div>
      <div className='mdl-note'>
        {t(
          'Gates are enforced by core, shown here so nothing refuses by surprise.',
        )}
      </div>
      <div className='mdl-body'>
        {error && <div className='mdl-error mono'>{error}</div>}
        {rows === null && !error && <div className='mdl-error mono'>…</div>}
        {rows?.map((m) => (
          <section key={m.id} className='mrow'>
            <div className='mrow-head'>
              <span className='mname'>{m.displayName}</span>
              <span className='mono mid'>{m.id}</span>
              <span className='mbadge kind'>{m.kind}</span>
              <span
                className='mbadge'
                title={m.license.name}
              >
                {m.license.spdx ?? m.license.name}
              </span>
              {m.license.requiresAcceptance && (
                <span className='mbadge gate'>
                  {t('license acceptance required')}
                </span>
              )}
              {(m.license.excludedTerritories?.length ?? 0) > 0 && (
                <span className='mbadge gate'>
                  {t('not available in')}: {m.license.excludedTerritories!.join(', ')}
                </span>
              )}
            </div>
            {m.versions.map((v) => (
              <VersionRow
                key={v.version}
                bridge={bridge}
                model={m}
                v={v}
                busy={busy}
                setBusy={setBusy}
                refresh={refresh}
              />
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
