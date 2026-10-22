/** The read-only character gallery. A card is a BUTTON: it opens the character's tab. */
import { useEffect, useState } from 'react';
import type { StudioBridge } from './bridge';
import type { CharacterCard } from './manifest';
import { t } from './i18n';

export function Thumb({ bridge, dir }: { bridge: StudioBridge; dir: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    bridge.readThumb(dir).then((s) => {
      if (!live) return;
      if (s) setSrc(s);
      else setMissing(true);
    }, () => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [bridge, dir]);
  return (
    <div className='thumb' aria-hidden='true'>
      {src
        ? <img src={src} alt='' />
        : <span className='nothumb'>{missing ? t('no bake yet') : '…'}</span>}
    </div>
  );
}

export function Card(
  { bridge, c, onOpen }: {
    bridge: StudioBridge;
    c: CharacterCard;
    onOpen: (dir: string) => void;
  },
) {
  const meta = [
    c.id !== c.displayName ? c.id : '',
    c.heightM !== undefined ? `${c.heightM.toFixed(2)} m` : '',
    c.pickedResultId ? `${t('pick')} ${c.pickedResultId}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <button
      type='button'
      className='card'
      onClick={() => onOpen(c.dir)}
      aria-label={`${t('Open')} ${c.displayName}`}
    >
      <Thumb bridge={bridge} dir={c.dir} />
      <div className='cardbody'>
        <div className='cardname'>{c.displayName}</div>
        {meta && <div className='cardid'>{meta}</div>}
        {c.problem
          ? (
            <div className='tags'>
              <span className='tag rig-warn'>{c.problem}</span>
            </div>
          )
          : (
            <div className='tags'>
              {c.stylePresetId && <span className='tag style'>{c.stylePresetId}</span>}
              {c.rig && (
                <span
                  className={`tag ${c.rig.accepted ? 'rig-ok' : 'rig-warn'}`}
                >
                  rig {c.rig.track}
                  {c.rig.jointCount !== undefined ? ` · ${c.rig.jointCount}j` : ''}
                  {c.rig.accepted ? ` · ${t('accepted')}` : ` · ${t('unaccepted')}`}
                </span>
              )}
              {c.lastBakeId && <span className='tag baked'>{t('baked')} {c.lastBakeId}</span>}
            </div>
          )}
      </div>
    </button>
  );
}

export function Gallery({ bridge, cards, loadError, onOpen, onUseDefault }: {
  bridge: StudioBridge;
  cards: CharacterCard[] | null;
  loadError: string | null;
  onOpen: (dir: string) => void;
  /** F1: a remembered root that vanished is an expectable state, not a dead
   * end - one press points the app back at its working directory */
  onUseDefault?: () => void;
}) {
  return (
    <div className='gallery'>
      {cards === null && !loadError && <p role='status'>{t('Loading characters…')}</p>}
      {loadError && (
        <div className='empty'>
          <p>{t('Could not read that root.')}</p>
          <p className='mono'>{loadError}</p>
          <p className='inote'>
            {t('the folder may have been moved or deleted — point at another, or')}{' '}
            {onUseDefault && (
              <button type='button' className='linkish' onClick={onUseDefault}>
                {t('use the default location')}
              </button>
            )}
          </p>
        </div>
      )}
      {cards && cards.length === 0 && (
        <div className='empty'>
          <p>{t('No characters under this root.')}</p>
          <p className='mono'>
            {t('Create a character from a reference image to begin.')}
          </p>
        </div>
      )}
      {cards?.map((c) => <Card key={c.dir} bridge={bridge} c={c} onOpen={onOpen} />)}
    </div>
  );
}
