import { useState } from 'react';
import type { StudioBridge } from './bridge';
import { useJobBridge } from './jobscope';
import { Inspector, Workbench } from './workbench';
import { CliTwin, FailureNote, type JobFailure, lastFailure } from './gen';
import { slugify, slugProblem } from './slug';
import { t } from './i18n';
import { useLandFocus } from './focus';
import { StageRail } from './stagerail';
import { stageStates } from './stages';

export function ImportCharacter({ bridge: baseBridge, projectsRoot, onCreated, onBack }: {
  bridge: StudioBridge;
  projectsRoot: string;
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const { bridge, busy, cancel } = useJobBridge(baseBridge, projectsRoot);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [example, setExample] = useState(true);
  const [failure, setFailure] = useState<JobFailure | null>(null);
  useLandFocus(true, '#import-name');
  const id = slugify(name);
  const ready = !slugProblem(id) && (example || path.trim().length > 0);
  const args = [
    'import',
    '--workspace',
    `${projectsRoot}/${id || '<id>'}`,
    '--name',
    name,
    ...(example ? ['--example'] : ['--model', path]),
  ];
  const create = async () => {
    if (!ready || busy) return;
    setFailure(null);
    try {
      const result = await bridge.runCli([...args, '--json']);
      if (result.exitCode === 0) onCreated(id);
      else {setFailure(
          lastFailure(result.lines) ?? {
            code: null,
            message: result.exitCode === 130
              ? t('Job canceled')
              : t('Import failed. The log drawer has the reason.'),
          },
        );}
    } catch (error) {
      setFailure({ code: null, message: String(error) });
    }
  };
  return (
    <div className='newcharacter'>
      <StageRail stages={stageStates(null)} active='gen' onSelect={() => {}} />
      <Workbench title={name.trim() || t('New character')}>
        <div className='gennew workbench-stage'>
          <section className='asset-workspace source-workspace'>
            <div className='panel-heading'>
              <h2>{t('Start with a mesh')}</h2>
              <button type='button' className='linkish' onClick={onBack} disabled={busy}>
                {t('Back to reference image')}
              </button>
            </div>
            <div className='source-well'>
              <div className='well-empty'>
                <h2>{example ? t('Try the offline character') : t('Keep your existing rig')}</h2>
                <p>
                  {example
                    ? t('A bundled CC0 humanoid. No model downloads or AI rigging required.')
                    : t(
                      'Mesh, materials and existing skin weights pass through the canonical importer.',
                    )}
                </p>
                <p>
                  {t('Review walking and jumping in Rig, then choose the look and export sprites.')}
                </p>
              </div>
            </div>
          </section>
          <Inspector>
            <div className='settings-fields'>
              <fieldset className='settings-group' disabled={busy}>
                <section className='control-section'>
                  <h2>{t('Character')}</h2>
                  <label className='field'>
                    {t('Name')}
                    <input
                      id='import-name'
                      className='rootinput'
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <p className='slugpreview mono'>{t('id')}: {id || '—'}</p>
                </section>
                <section className='control-section'>
                  <h2>{t('Source')}</h2>
                  <label className='check-field'>
                    <input
                      type='checkbox'
                      checked={example}
                      onChange={(e) => setExample(e.target.checked)}
                    />
                    {t('Use the bundled reference character')}
                  </label>
                  {!example && (
                    <label className='field'>
                      {t('Mesh path')}
                      <input
                        className='rootinput'
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        spellCheck={false}
                        placeholder='.glb, .gltf, .fbx, .obj, .vrm'
                      />
                    </label>
                  )}
                  <p className='inote'>
                    {t(
                      'Existing rigs are preserved, not automatically accepted. Static meshes still need a rig.',
                    )}
                  </p>
                </section>
              </fieldset>
            </div>
            <section className='control-section action-section'>
              <button
                type='button'
                className='btn primary'
                disabled={!ready}
                aria-busy={busy}
                onClick={create}
              >
                {busy ? t('Importing…') : t('Import character')}
              </button>
              {busy && (
                <button type='button' className='btn' onClick={cancel} title='CLI: Ctrl+C'>
                  {t('Cancel job')}
                </button>
              )}
              {failure && <FailureNote failure={failure} />}
              <CliTwin args={args} />
            </section>
          </Inspector>
        </div>
      </Workbench>
    </div>
  );
}
