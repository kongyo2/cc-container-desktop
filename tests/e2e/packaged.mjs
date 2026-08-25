import { existsSync } from 'node:fs';
import { _electron as electron } from 'playwright';

const executablePath = process.argv[2] ?? '';
if (executablePath === '' || !existsSync(executablePath)) {
  console.error(`packaged binary not found: ${JSON.stringify(executablePath)}`);
  process.exit(2);
}

let failures = 0;
let step = 0;

function check(label, condition, detail = '') {
  step += 1;
  const tag = String(step).padStart(2, '0');
  if (condition) console.log(`  ✓ ${tag} ${label}${detail === '' ? '' : ` — ${detail}`}`);
  else {
    failures += 1;
    console.error(`  ✗ ${tag} ${label} — ${detail === '' ? 'assertion failed' : detail}`);
  }
}

const app = await electron.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'] });

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

  const painted = await page.evaluate(() => document.body.innerText.trim().length > 0);
  check('window rendered', painted);
} catch (error) {
  step += 1;
  failures += 1;
  console.error(
    `  ✗ ${String(step).padStart(2, '0')} harness — ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  await app.close().catch(() => undefined);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${step} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
