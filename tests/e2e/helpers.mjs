import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

import { ensureTestImages } from './fixtures/registry.mjs';

const SHOT_DIR = process.env['CC_E2E_SCREENSHOT_DIR'] ?? '';

export const TASK_PREFIX = 'e2e-';

let failures = 0;
let step = 0;

export function check(label, condition, detail = '') {
  step += 1;
  const tag = String(step).padStart(2, '0');
  if (condition) {
    console.log(`  ✓ ${tag} ${label}${detail === '' ? '' : ` — ${detail}`}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${tag} ${label} — ${detail === '' ? 'assertion failed' : detail}`);
  }
  return condition;
}

export function harnessFailure(error) {
  step += 1;
  failures += 1;
  console.error(
    `  ✗ ${String(step).padStart(2, '0')} harness — ${error instanceof Error ? error.stack : String(error)}`,
  );
}

export function finish() {
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${step} checks)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

export async function call(page, method, args = []) {
  const result = await page.evaluate(([name, callArgs]) => window.cc[name](...callArgs), [method, args]);
  if (result === null || typeof result !== 'object' || !('ok' in result)) {
    throw new Error(`${method}: unexpected reply ${JSON.stringify(result)}`);
  }
  return result;
}

export function errorText(result) {
  if (result.ok) return '';
  return typeof result.error === 'object' && result.error !== null
    ? `${result.error.code}: ${result.error.message}`
    : String(result.error);
}

export function errorCode(result) {
  if (result.ok) return '';
  return typeof result.error === 'object' && result.error !== null ? result.error.code : '';
}

export async function ok(page, method, args = []) {
  const result = await call(page, method, args);
  if (!result.ok) throw new Error(`${method}: ${errorText(result)}`);
  return result.value;
}

export function isTransient(text) {
  return /rate.?limit|429|50[234]|overloaded|temporarily|empty or malformed response|Provider returned error/iu.test(
    text,
  );
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function shoot(page, name) {
  if (SHOT_DIR === '') return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false });
}

export async function goView(page, view) {
  await page.click(`.sidebar-nav button[data-view="${view}"]`);
  await page.waitForTimeout(400);
}

export async function selectTask(page, taskId) {
  await page.click(`.task-item[data-task-id="${taskId}"]`);
  await page.waitForTimeout(300);
}

export async function waitFor(page, probe, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  /* oxlint-disable no-await-in-loop -- polling is sequential by nature */
  while (!predicate(value) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    value = await probe();
  }
  /* oxlint-enable no-await-in-loop */
  return value;
}

export async function sh(page, taskId, line, { asRoot = false } = {}) {
  return ok(page, 'taskExec', [taskId, { command: ['bash', '-lc', line], asRoot }]);
}

export async function readContainerFile(page, taskId, path) {
  const result = await sh(page, taskId, `cat -- ${shellQuote(path)}`);
  if (result.exitCode !== 0) throw new Error(`cat ${path}: exit ${result.exitCode}: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function readContainerJson(page, taskId, path) {
  return JSON.parse(await readContainerFile(page, taskId, path));
}

export async function writeContainerFile(page, taskId, path, content) {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const written = await sh(
    page,
    taskId,
    `mkdir -p -- "$(dirname -- ${shellQuote(path)})" && printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`,
  );
  if (written.exitCode !== 0) throw new Error(`write ${path}: ${written.stderr.trim()}`);
}

export function taskById(snapshot, taskId) {
  return snapshot.tasks.find((view) => view.task.id === taskId) ?? null;
}

function operationById(snapshot, operationId) {
  return snapshot.operations.find((operation) => operation.id === operationId) ?? null;
}

export function imageByEntry(snapshot, catalogEntryId) {
  return snapshot.images.find((view) => view.image.catalogEntryId === catalogEntryId) ?? null;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export async function waitForOperation(page, operationId, timeoutMs = 600_000) {
  const done = await waitFor(
    page,
    async () => operationById(await ok(page, 'snapshot'), operationId),
    (operation) => operation !== null && TERMINAL.has(operation.phase),
    timeoutMs,
  );
  if (done === null) throw new Error(`operation ${operationId} vanished`);
  return done;
}

export async function launchIsolated({ extraEnv = {}, withImages = true, userData: reuseUserData = null } = {}) {
  const fixture = withImages ? ensureTestImages() : null;
  const userData = reuseUserData ?? mkdtempSync(join(tmpdir(), 'cc-e2e-'));
  const env = {
    ...process.env,
    ...extraEnv,
    CC_USER_DATA_DIR: userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ...(fixture === null ? {} : { CC_IMAGE_CATALOG_FILE: fixture.catalogFile }),
  };
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.cc === 'object' && window.cc !== null);
  await page.waitForTimeout(800);

  const created = new Map();

  const session = {
    app,
    page,
    userData,
    created,
    fixture,

    async registerImage(catalogEntryId = fixture?.releaseOne.id) {
      const operation = await ok(page, 'imageDownloadStart', [{ catalogEntryId }]);
      const done = await waitForOperation(page, operation.id);
      if (done.phase !== 'succeeded') {
        throw new Error(`download of ${catalogEntryId} ended ${done.phase}: ${done.error?.message ?? ''}`);
      }
      const view = imageByEntry(await ok(page, 'snapshot'), catalogEntryId);
      if (view === null) throw new Error(`${catalogEntryId} is not registered after a successful download`);
      return view;
    },

    async ensureEnvironment({ name = 'e2e-env', imageId = null } = {}) {
      const snapshot = await ok(page, 'snapshot');
      const existing = snapshot.config.environments.find((environment) => !environment.archived);
      if (existing !== undefined && imageId === null) return existing.id;
      const chosen = imageId ?? (await this.registerImage()).image.id;
      const id = `e2e-env-${Date.now().toString(36)}`;
      await ok(page, 'environmentUpsert', [{ id, name, imageId: chosen, envText: '', setupScript: '' }]);
      return id;
    },

    async createTask(input) {
      const environmentId = input.environmentId === undefined ? await this.ensureEnvironment() : input.environmentId;
      const result = await ok(page, 'taskCreate', [
        { note: '', profileId: null, source: { kind: 'empty' }, ...input, environmentId },
      ]);
      created.set(result.task.id, result.task);
      return result;
    },

    forgetTask(taskId) {
      created.delete(taskId);
    },

    async close({ keepUserData = false } = {}) {
      try {
        /* oxlint-disable no-await-in-loop -- deletions share one Docker connection; keep them sequential */
        for (const taskId of [...created.keys()]) {
          const result = await call(page, 'taskDelete', [taskId, { exportFirst: false }]);
          if (result.ok) created.delete(taskId);
          else console.error(`    cleanup: taskDelete(${taskId}) → ${errorText(result)}`);
        }
        /* oxlint-enable no-await-in-loop */
      } catch (error) {
        console.error(`    cleanup through the app failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await app.close().catch(() => undefined);
      for (const task of created.values()) {
        try {
          execFileSync('docker', ['rm', '-f', task.containerName], { stdio: 'ignore' });
        } catch {}
        try {
          execFileSync('docker', ['volume', 'rm', '-f', task.volumeName], { stdio: 'ignore' });
        } catch {}
      }
      if (!keepUserData) rmSync(userData, { recursive: true, force: true });
    },
  };
  return session;
}
