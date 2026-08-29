import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const pageErrors = [];

const electronApp = await electron.launch({ args: [resolve('.')] });
try {
  const page = await electronApp.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.waitForLoadState('load');
  await page.waitForTimeout(1_000);

  const rootHtml = await page.locator('#root').innerHTML();
  assert.ok(rootHtml.trim(), 'renderer root must contain the mounted application');
  assert.deepEqual(pageErrors, [], `unexpected renderer errors: ${pageErrors.join('; ')}`);
  console.log(JSON.stringify({ ok: true, entryUrl: page.url() }));
} finally {
  await electronApp.close();
}
