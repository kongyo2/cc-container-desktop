import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

import { activeView, check, countOf, finish, firstReadyPage, harnessFailure } from './helpers.mjs';

const executablePath = process.argv[2] ?? '';
if (executablePath === '' || !existsSync(executablePath)) {
  console.error(`packaged binary not found: ${JSON.stringify(executablePath)}`);
  process.exit(2);
}

const userData = mkdtempSync(join(tmpdir(), 'cc-packaged-'));
const app = await electron.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-gpu'],
  env: { ...process.env, CC_USER_DATA_DIR: userData, CC_IMAGE_CATALOG_FILE: '/nonexistent/catalog.json' },
});

try {
  const page = await firstReadyPage(app, 1200);

  const packaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
  check('running the packaged build', packaged === true, String(packaged));

  const snapshot = await page.evaluate(() => window.cc.snapshot());
  check('snapshot works', snapshot.ok === true, snapshot.ok ? '' : snapshot.error);
  check('config has the default profile', snapshot.ok && snapshot.value.config.profiles.length >= 1);
  check('config is the state-v1 shape', snapshot.ok && snapshot.value.config.schemaVersion === 1);
  check(
    'config seeds no environment and the data dir is state-v1',
    snapshot.ok && snapshot.value.config.environments.length === 0 && snapshot.value.dataDir.endsWith('state-v1'),
  );
  check('task list starts empty', snapshot.ok && snapshot.value.tasks.length === 0);
  check('nothing is registered on a fresh install', snapshot.ok && snapshot.value.images.length === 0);
  check(
    'the bundled catalog lists all eight variants from one repository',
    snapshot.ok &&
      snapshot.value.catalog.entries.length === 8 &&
      snapshot.value.catalog.entries.filter((entry) => entry.recommended).length === 1 &&
      snapshot.value.catalog.repository.startsWith('docker.io/'),
  );
  check('no store problems', snapshot.ok && snapshot.value.storeProblems.length === 0);
  check('docker reachable from the packaged app', snapshot.ok && snapshot.value.docker.available === true);

  const dockerfile = await app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    return fs.existsSync(path.join(process.resourcesPath, 'docker'));
  });
  check('no Dockerfile is shipped with the app', dockerfile === false);

  const catalogOverride = await app.evaluate(() => process.env.CC_IMAGE_CATALOG_FILE ?? '');
  check(
    'the packaged app ignores catalog overrides',
    catalogOverride !== '' && snapshot.ok && snapshot.value.catalog.entries.length === 8,
  );

  const view = await activeView(page);
  check('a fresh install opens on the Images page', view === 'images', view);
  const cards = await countOf(page, '[data-testid="image-card"]');
  check('the Images page shows the eight variants', cards === 8, String(cards));
  const recommended = await countOf(page, '.image-card.recommended');
  check('one card is marked as recommended', recommended === 1, String(recommended));
  const downloadButtons = await page.evaluate(
    () => [...document.querySelectorAll('[data-testid="image-download"]')].filter((button) => !button.disabled).length,
  );
  check(
    'every card offers "Download and register" while Docker is reachable',
    downloadButtons === 8,
    String(downloadButtons),
  );
  await page.click('.sidebar-nav button[data-view="environments"]');
  await page.waitForTimeout(500);
  const rows = await countOf(page, '[data-testid="env-list"] .env-row');
  check('the environments page starts empty', rows === 0, String(rows));

  const painted = await page.evaluate(() => document.body.innerText.trim().length > 0);
  check('window rendered', painted);
} catch (error) {
  harnessFailure(error);
} finally {
  await app.close().catch(() => undefined);
  rmSync(userData, { recursive: true, force: true });
}

finish();
