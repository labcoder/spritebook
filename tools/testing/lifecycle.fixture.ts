import { after, test } from 'node:test';

let timer: ReturnType<typeof setInterval> | undefined;
test('resource guard fixture', () => {
  if (process.env.SPRITEBOOK_LEAK_FIXTURE) timer = setInterval(() => {}, 1000);
});
// Allow the negative self-check to exit after the guard has reported the leak.
after(() => clearInterval(timer));
