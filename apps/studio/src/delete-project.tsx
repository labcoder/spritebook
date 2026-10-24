import { useState } from 'react';
import type { StudioBridge } from './bridge';
import { deleteProjectArgs } from './args';
import { CliTwin } from './gen';
import { t } from './i18n';
import { Modal } from './modal';

export function DeleteProject({ bridge, project, onClose, onDeleted }: {
  bridge: StudioBridge;
  project: { dir: string; id: string; displayName: string };
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const args = deleteProjectArgs(project.dir, project.id);
  const remove = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await bridge.runCli([...args, '--json']);
      if (result.exitCode !== 0) {
        const failure = result.lines.map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).find((event) => event?.t === 'error');
        throw new Error(
          failure?.message ?? t('Could not delete this project. Open the log for details.'),
        );
      }
      onDeleted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setRunning(false);
    }
  };
  return (
    <Modal
      open
      label={`${t('Delete project')}: ${project.displayName}`}
      className='delete-project'
      initialFocus='.delete-cancel'
      onClose={() => {
        if (!running) onClose();
      }}
    >
      <h2>
        {t('Delete project')} <span>{project.displayName}</span>?
      </h2>
      <p>
        {t(
          'Permanently delete generated meshes, textures, rigs, animations and sprite sheets for this character? This cannot be undone.',
        )}
      </p>
      <p className='delete-preserved'>
        {t(
          'Your original source input is kept in the source folder. Installed extensions, files outside this project and unrecognized user files are kept.',
        )}
      </p>
      <p className='mono delete-path'>{project.dir}</p>
      <CliTwin args={args} />
      {error && <p role='alert' className='joberror'>{error}</p>}
      <div className='delete-actions'>
        <button type='button' className='btn delete-cancel' disabled={running} onClick={onClose}>
          {t('Cancel')}
        </button>
        <button type='button' className='btn danger' aria-busy={running} onClick={remove}>
          {running ? t('Deleting project…') : t('Delete project')}
        </button>
      </div>
    </Modal>
  );
}
