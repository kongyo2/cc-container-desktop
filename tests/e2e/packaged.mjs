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
  check('config is the v3 shape', snapshot.ok && snapshot.value.config.version === 3);
  check(
    'config seeds a default environment',
    snapshot.ok &&
      snapshot.value.config.environments.length === 1 &&
      snapshot.value.config.defaultEnvironmentId === snapshot.value.config.environments[0].id,
  );
  check('task list starts empty', snapshot.ok && snapshot.value.tasks.length === 0);
  check('docker reachable from the packaged app', snapshot.ok && snapshot.value.docker.available === true);

  const dockerfile = await app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const file = path.join(process.resourcesPath, 'docker', 'Dockerfile');
    return {
      file,
      exists: fs.existsSync(file),
      head: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(0, 2000) : '',
    };
  });
  check(
    'the bundled Dockerfile ships outside the asar',
    dockerfile.exists && !dockerfile.file.includes('app.asar'),
    dockerfile.file,
  );
  check('and it is the real base image', dockerfile.head.includes('FROM ubuntu:24.04'), dockerfile.head.slice(0, 60));

  await page.click('.sidebar-nav button[data-view="environments"]');
  await page.waitForTimeout(500);
  const tools = await page.evaluate(
    () => document.querySelectorAll('[data-testid="base-image-tools"] tbody tr').length,
  );
  check('the environments page lists the base image tools', tools === 11, String(tools));
  const rows = await page.evaluate(() => document.querySelectorAll('[data-testid="env-list"] .env-row').length);
  check('and the seeded environment', rows === 1, String(rows));

  const painted = await page.evaluate(() => document.body.innerText.trim().length > 0);
  check('window rendered', painted);
} catch (error) {
  harnessFailure(error);
} finally {
  await app.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
}

finish();
