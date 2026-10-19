import { useLayoutEffect, useMemo, useState } from 'react';
import type { CliRun, StudioBridge } from './bridge';
import { log } from './log';

const canceled = (): CliRun => ({ exitCode: 130, lines: [] });

/** A mounted character/stage owns its work; old completions cannot report success. */
export function useJobBridge(base: StudioBridge, key: string) {
  const [running, setRunning] = useState(0);
  const scope = useMemo(
    () => ({ live: true, controller: new AbortController() }),
    [base, key],
  );
  useLayoutEffect(() => {
    scope.live = true;
    setRunning(0);
    return () => {
      scope.live = false;
      scope.controller.abort();
    };
  }, [scope]);
  const bridge = useMemo<StudioBridge>(() => ({
    ...base,
    async runCli(args, onLine) {
      if (!scope.live) return canceled();
      if (scope.controller.signal.aborted) {
        scope.controller = new AbortController();
      }
      const { signal } = scope.controller;
      setRunning((n) => n + 1);
      try {
        const result = await base.runCli(args, (line) => {
          if (!signal.aborted) onLine?.(line);
        }, signal);
        return signal.aborted ? canceled() : result;
      } catch (e) {
        log.append(args[0] ?? 'cli', String(e), Date.now(), 'stderr');
        return { exitCode: 1, lines: [] };
      } finally {
        if (scope.live) setRunning((n) => Math.max(0, n - 1));
      }
    },
  }), [base, scope]);
  return { bridge, busy: running > 0, cancel: () => scope.controller.abort() };
}
