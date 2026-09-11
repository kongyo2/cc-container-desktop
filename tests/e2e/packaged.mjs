import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

import { check, finish, harnessFailure } from './helpers.mjs';

const executablePath = process.argv[2] ?? '';
if (executablePath === '' || !existsSync(executablePath)) {
  console.error(`packaged binary not found: ${JSON.stringify(executablePath)}`);
  process.exit(2);
}

// A scratch userData so the smoke test never reads or writes the real config.
const userData = mkdtempSync(join(tmpdir(), 'cc-packaged-'));
const app = await electron.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-gpu'],
  env: { ...process.env, CC_USER_DATA_DIR: userData },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.cc === 'object' && window.cc !== null);
  await page.waitForTimeout(1200);

  const packaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
  check('running the packaged build', packaged === true, String(packaged));

  const snapshot = await page.evaluate(() => window.cc.snapshot());
  check('snapshot works', snapshot.ok === true, snapshot.ok ? '' : snapshot.error);
  check('config has the default profile', snapshot.ok && snapshot.value.config.profiles.length >= 1);
  check('config is the v2 shape', snapshot.ok && snapshot.value.config.version === 2);
  check('task list starts empty', snapshot.ok && snapshot.value.tasks.length === 0);
  check('docker reachable from the packaged app', snapshot.ok && snapshot.value.docker.available === true);

  const sources = await page.evaluate(() => window.cc.imageSourcesGet());
  check('image sources resolved from resourcesPath', sources.ok === true, sources.ok ? '' : sources.error);
  check(
    'Dockerfile content is the real one',
    sources.ok && sources.value.dockerfile.includes('FROM ubuntu:24.04'),
    sources.ok ? sources.value.dockerfile.slice(0, 60) : '',
  );
  check('post-create content is the real one', sources.ok && sources.value.postCreate.includes('post-create'));
  check(
    'sources were seeded into userData, not read from the asar',
    sources.ok && !sources.value.dir.includes('app.asar'),
    sources.ok ? sources.value.dir : '',
  );
  check(
    'sources landed in the scratch userData',
    sources.ok && sources.value.dir.startsWith(userData),
    sources.ok ? sources.value.dir : '',
  );

  const painted = await page.evaluate(() => document.body.innerText.trim().length > 0);
  check('window rendered', painted);
} catch (error) {
  harnessFailure(error);
} finally {
  await app.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
}

finish();
