import { useEffect, useState } from 'react';
import type { StudioBridge } from './bridge';
import { t } from './i18n';

export interface ClipMeta {
  id: string;
  name: string;
  category: string;
  tags: string[];
  durationS: number;
  loop: boolean;
}

export function useClipLibrary(bridge: StudioBridge) {
  const [clips, setClips] = useState<ClipMeta[] | null>(null);
  const [packId, setPackId] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    bridge.runCli(['anim', '--list', '--json']).then((r) => {
      if (!live) return;
      if (r.exitCode !== 0 || r.lines.length === 0) {
        setError(t('could not read the clip library — the log drawer has the verbatim reason'));
        return;
      }
      try {
        const doc = JSON.parse(r.lines.at(-1)!);
        const first = Array.isArray(doc.packs) ? doc.packs[0] : doc;
        if (!Array.isArray(first?.clips)) throw new Error('Missing clips');
        setClips((first?.clips ?? []) as ClipMeta[]);
        setPackId(String(first?.pack ?? ''));
      } catch {
        setError(t('clip library output was not JSON'));
      }
    }).catch(() => {
      if (live) {
        setError(t('could not read the clip library — the log drawer has the verbatim reason'));
      }
    });
    return () => {
      live = false;
    };
  }, [bridge]);
  return { clips, packId, error };
}
