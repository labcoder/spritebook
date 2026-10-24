/** Bounded downstream comparison. Keeps failures and never accepts/promotes a candidate. */
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { readCurrentBake, readWorkspace, sha256Bytes } from '@spritebook/core';
import { decode } from '@spritebook/image';
import { runProcess } from '../testing/process.ts';

const root = resolve(process.argv[2] ?? '.render-bench/character-cohort');
const refs = JSON.parse(await fs.readFile(join(root, 'references.json'), 'utf8')).references as {
  id: string;
  imageSha256: string;
}[];
assert([1, 2, 8].includes(refs.length), 'Use a frozen baseline or corrected-control cohort');
const deadline = Date.now() + 4 * 60 * 60 * 1000;
const digest = async (path: string) => sha256Bytes(await fs.readFile(path));
while (Date.now() < deadline) {
  let complete = 0;
  for (const ref of refs) {
    for (const model of ['pixal3d', 'trellis2-4b']) {
      const dir = join(root, 'runs', `${ref.id}-${model}`);
      let generation;
      try {
        generation = JSON.parse(await fs.readFile(join(dir, 'completed.json'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      assert.equal(
        generation.referenceSha256,
        ref.imageSha256,
        'Reference changed after generation',
      );
      if (generation.exitCode !== 0) {
        complete += 2;
        continue;
      }
      const workspace = join(dir, 'character');
      const manifest = await readWorkspace(workspace);
      assert(manifest.generation.results.length <= 2, 'Candidate budget exceeded');
      const metadata = JSON.parse(
        await fs.readFile(join(workspace, 'results/r1/gen-meta.json'), 'utf8'),
      );
      const requested = metadata.candidates.map((candidate: { requestedSeed: number }) =>
        candidate.requestedSeed
      );
      assert.equal(new Set(requested).size, requested.length, 'Duplicate requested seed');
      assert(requested.every((seed: number) => [0, 1000].includes(seed)), 'Unexpected seed budget');
      assert.deepEqual(
        manifest.generation.results.map((result) => result.seed).sort((a, b) => a - b),
        metadata.candidates.map((candidate: { effectiveSeed: number }) => candidate.effectiveSeed)
          .sort((a: number, b: number) => a - b),
      );
      const generationWarnings = (await fs.readFile(join(dir, 'generation.ndjson'), 'utf8')).split(
        /\r?\n/,
      ).filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.t === 'warn');
      for (const result of manifest.generation.results) {
        assert(
          Date.now() < deadline,
          'Cohort exceeded its four-hour budget; retained partial evidence',
        );
        const out = join(dir, `evaluation-${result.id}`);
        const receipt = join(out, 'completed.json');
        assert.equal(
          await digest(join(workspace, 'results', result.id, 'model.glb')),
          result.output.gltfSha256,
          'Candidate bytes changed after generation',
        );
        try {
          const existing = JSON.parse(await fs.readFile(receipt, 'utf8'));
          assert.deepEqual(existing.source, result, 'Completed evaluation has another source');
          existing.generationMeta = metadata;
          existing.generationWarnings = generationWarnings;
          await fs.writeFile(receipt, JSON.stringify(existing, null, 2));
          complete++;
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await fs.mkdir(out, { recursive: true });
        const before = await digest(join(workspace, 'character.json'));
        const transcript: unknown[] = [];
        async function cli(args: string[]) {
          const start = performance.now();
          const remaining = deadline - Date.now();
          assert(remaining > 0, 'Cohort time budget exhausted');
          const run = await runProcess(process.execPath, [
            resolve('packages/cli/dist/entry.js'),
            ...args,
            '--json',
          ], { timeout: Math.min(1800000, remaining) });
          const stdout = new TextDecoder().decode(run.stdout);
          transcript.push({
            args,
            exitCode: run.code,
            signal: run.signal,
            seconds: (performance.now() - start) / 1000,
            stdout,
            stderr: new TextDecoder().decode(run.stderr),
          });
          await fs.writeFile(join(out, 'transcript.json'), JSON.stringify(transcript, null, 2));
          assert.equal(run.code, 0, stdout.slice(-4000));
          return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        }
        const start = performance.now();
        const report: Record<string, unknown> = {
          design: ref.id,
          model,
          source: result,
          generationSeconds: generation.seconds,
          generationMeta: metadata,
          generationWarnings,
          visualReview: 'pending',
        };
        try {
          const events = await cli([
            'anim',
            '--audition',
            '--result',
            result.id,
            '--workspace',
            workspace,
          ]);
          const child = events.findLast((event) => event.kind === 'candidate-workspace')?.path;
          assert.equal(typeof child, 'string');
          report.motion = JSON.parse(
            await fs.readFile(join(child, 'anim/motion-review.json'), 'utf8'),
          );
          const deliveries: unknown[] = [];
          for (
            const [name, cell, directions, elevation, yaw, ppm, padding] of [
              ['side-64', '64x80', '2', '0', '90', '23', '8'],
              ['iso-256', '256x320', '8', '35.3', '0', '90', '64'],
            ]
          ) {
            await cli([
              'bake',
              '--workspace',
              child,
              '--clips',
              'walk-loop:12,jump-start:8!hold,jump-loop:8,jump-land:8!hold',
              '--style',
              'clean',
              '--cell',
              cell,
              '--directions',
              directions,
              '--elevation',
              elevation,
              '--yaw',
              yaw,
              '--ppm',
              ppm,
              '--padding',
              padding,
              '--cache',
              join(root, 'cache'),
            ]);
            const bake = await readCurrentBake(child);
            assert(bake);
            assert.equal(bake.manifest.frames.length, 36 * Number(directions));
            assert.equal(bake.manifest.frames.some((frame) => frame.mirroredFrom), false);
            for (const page of bake.manifest.atlases) {
              const image = decode(await fs.readFile(join(bake.dir, page.png)));
              assert.equal(image.width, page.sizePx);
              assert.equal(image.height, page.sizePx);
            }
            await cli([
              'export',
              '--workspace',
              child,
              '--out',
              join(out, name),
              '--targets',
              'godot,texturepacker,strips',
              '--mesh',
            ]);
            deliveries.push({
              name,
              bakeDir: bake.dir,
              flags: bake.manifest.flags,
              frames: bake.manifest.frames.length,
            });
          }
          report.deliveries = deliveries;
          report.technicalComplete = true;
        } catch (error) {
          report.technicalComplete = false;
          report.error = String(error);
        }
        assert.equal(
          await digest(join(workspace, 'character.json')),
          before,
          'Candidate review changed the selected character',
        );
        report.seconds = (performance.now() - start) / 1000;
        await fs.writeFile(receipt, JSON.stringify(report, null, 2));
        console.log(
          'EVALUATED',
          ref.id,
          model,
          result.id,
          report.technicalComplete,
          report.seconds,
        );
        complete++;
      }
      if (manifest.generation.results.length < 2) {
        await fs.writeFile(
          join(dir, 'candidate-shortfall.json'),
          JSON.stringify(
            {
              expected: 2,
              actual: manifest.generation.results.length,
              generation,
              generationMeta: metadata,
              generationWarnings,
            },
            null,
            2,
          ),
        );
        complete += 2 - manifest.generation.results.length;
      }
    }
  }
  if (complete === refs.length * 4) break;
  await new Promise((resolve) => setTimeout(resolve, 20000));
}
assert(Date.now() < deadline, 'Cohort exceeded its four-hour bound; retained partial evidence');
