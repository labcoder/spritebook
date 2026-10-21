import { stat } from 'node:fs/promises';
import type { JobEvent } from '@spritebook/schema';
import type { Fetcher } from './install.ts';

/** Coalesce byte callbacks while the job consumer is busy, without buffering the download. */
export async function* downloadFile(
  fetcher: Fetcher,
  url: string,
  path: string,
  bytes: number,
  jobId: JobEvent['jobId'],
  step: string,
): AsyncIterable<JobEvent> {
  const progress = (done: number): JobEvent => ({
    t: 'progress',
    jobId,
    at: new Date().toISOString(),
    step,
    done,
    total: Math.max(1, bytes),
  });
  yield progress(0);
  let seen = 0, finished = false, lastUpdate = -Infinity;
  let update = Promise.withResolvers<void>();
  const download = Promise.resolve().then(() =>
    fetcher(url, path, (count) => {
      seen = count;
      if (performance.now() - lastUpdate >= 100) {
        lastUpdate = performance.now();
        update.resolve();
      }
    })
  ).then(async () => {
    seen = (await stat(path)).size;
  }).finally(() => {
    finished = true;
    update.resolve();
  });
  void download.catch(() => {});
  try {
    while (!finished) {
      await update.promise;
      update = Promise.withResolvers<void>();
      yield progress(seen);
    }
  } finally {
    await download;
  }
}
