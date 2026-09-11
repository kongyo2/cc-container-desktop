// The end-to-end path a user takes, against a live endpoint:
// build the image, set up a profile, create a task, watch Claude Code answer
// inside it, keep the tmux session across a closed tab, move files in and out,
// and delete the task. Needs Docker and CC_E2E_API_KEY.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  call,
  check,
  finish,
  goView,
  harnessFailure,
  isTransient,
  launchIsolated,
  ok,
  readContainerJson,
  selectTask,
  sh,
  shoot,
  taskById,
  TASK_PREFIX,
  writeContainerFile,
} from './helpers.mjs';

const API_KEY = process.env['CC_E2E_API_KEY'] ?? '';
const BASE_URL = process.env['CC_E2E_BASE_URL'] ?? 'https://openrouter.ai/api';
const MODEL = process.env['CC_E2E_MODEL'] ?? 'stealth/ox-alpha';
const SKIP_BUILD = process.env['CC_E2E_SKIP_BUILD'] === '1';

if (API_KEY === '') {
  console.error('CC_E2E_API_KEY is required');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'cc-workbench-'));
const session = await launchIsolated();
const { page, app } = session;

try {
  console.log('\n[1] app + docker');
  const bridged = await page.evaluate(() => Object.keys(window.cc).length);
  check('preload bridge exposed', bridged > 30, `${bridged} methods`);

  let snapshot = await ok(page, 'snapshot');
  check('docker reachable', snapshot.docker.available === true, snapshot.docker.error ?? `v${snapshot.docker.version}`);
  check(
    'starter profile present',
    snapshot.config.profiles.length >= 1,
    `${snapshot.config.profiles.length} profile(s)`,
  );
  check('no tasks in a fresh userData', snapshot.tasks.length === 0);
  await shoot(page, '01-welcome');

  console.log('\n[2] image');
  if (!SKIP_BUILD) {
    await ok(page, 'imageBuild', [{ noCache: false, refreshClaudeCode: false }]);
  }
  snapshot = await ok(page, 'snapshot');
  check('image exists', snapshot.image.exists === true, snapshot.image.tag);
  check(
    'a default environment is ready for the first task',
    typeof snapshot.config.defaultEnvironmentId === 'string' &&
      snapshot.config.environments.some((environment) => environment.id === snapshot.config.defaultEnvironmentId),
  );

  console.log('\n[3] profile + credential');
  const profile = {
    ...snapshot.config.profiles[0],
    name: 'E2E OpenRouter',
    baseUrl: BASE_URL,
    authMode: 'authToken',
    model: MODEL,
    sonnetModel: MODEL,
    opusModel: MODEL,
    haikuModel: MODEL,
    apiTimeoutMs: null,
    contextTokens: 1048576,
    disableNonEssentialTraffic: true,
    disableTelemetry: true,
    extraEnv: {},
    note: 'created by tests/e2e/workbench.mjs',
  };
  await ok(page, 'profileUpsert', [profile]);
  await ok(page, 'configSave', [{ defaultProfileId: profile.id }]);
  await ok(page, 'secretSet', [profile.id, API_KEY]);
  const readBack = await ok(page, 'secretGet', [profile.id]);
  check('credential round-trips through the store', readBack === API_KEY, `${readBack.length} chars`);

  console.log('\n[4] task creation provisions its own container');
  const created = await session.createTask({ name: `${TASK_PREFIX}workbench`, profileId: profile.id });
  const task = created.task;
  check('task created without a provisioning warning', created.warning === null, created.warning ?? '');
  check('task has its own container name', task.containerName === `cc-task-${task.id}`, task.containerName);
  snapshot = await ok(page, 'snapshot');
  const view = taskById(snapshot, task.id);
  check('task container running', view?.container.running === true, view?.container.status ?? 'no view');
  check('task uses the profile it was created with', view?.task.profileId === profile.id);
  check(
    'task was created on the default environment and is current',
    view?.task.environmentId === snapshot.config.defaultEnvironmentId && view?.environmentStale === false,
  );

  const claudeJson = await readContainerJson(page, task.id, '/home/claude/.claude.json');
  check('hasCompletedOnboarding is true', claudeJson.hasCompletedOnboarding === true);
  check(
    'workspace is trusted',
    claudeJson.projects?.['/home/claude/workspace']?.hasTrustDialogAccepted === true,
    JSON.stringify(claudeJson.projects ?? {}),
  );

  const settings = await readContainerJson(page, task.id, '/home/claude/.claude/settings.json');
  check('ANTHROPIC_BASE_URL written', settings.env?.ANTHROPIC_BASE_URL === BASE_URL, settings.env?.ANTHROPIC_BASE_URL);
  check('ANTHROPIC_MODEL written', settings.env?.ANTHROPIC_MODEL === MODEL, settings.env?.ANTHROPIC_MODEL);
  check(
    'context window declared',
    settings.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '1048576',
    settings.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  );
  check(
    'auth token written, api key explicitly blanked',
    settings.env?.ANTHROPIC_AUTH_TOKEN === API_KEY && settings.env?.ANTHROPIC_API_KEY === '',
  );

  console.log('\n[5] settings.json survives a rewrite of unrelated keys');
  const withExtra = { ...settings, statusLine: { type: 'command', command: 'echo hi' } };
  await writeContainerFile(
    page,
    task.id,
    '/home/claude/.claude/settings.json',
    `${JSON.stringify(withExtra, null, 2)}\n`,
  );
  await ok(page, 'taskProvision', [task.id]);
  const reProvisioned = await readContainerJson(page, task.id, '/home/claude/.claude/settings.json');
  check('hand-added keys preserved', reProvisioned.statusLine?.command === 'echo hi');
  check('env still correct', reProvisioned.env?.ANTHROPIC_MODEL === MODEL);

  console.log('\n[6] Claude Code answers over the endpoint');
  const marker = `E2E-${Date.now().toString(36).toUpperCase()}`;
  let probe = { exitCode: -1, stdout: '', stderr: '' };
  /* oxlint-disable no-await-in-loop */
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    probe = await sh(
      page,
      task.id,
      `node /opt/cc/onboard.cjs && claude --dangerously-skip-permissions -p 'Reply with exactly this token and nothing else: ${marker}'`,
    );
    if (probe.exitCode === 0 || !isTransient(`${probe.stdout}${probe.stderr}`)) break;
    console.log(`    … upstream busy, retrying (${attempt}/4)`);
    await page.waitForTimeout(6000 * attempt);
  }
  /* oxlint-enable no-await-in-loop */
  const transcript = `${probe.stdout}${probe.stderr}`.trim();
  check('claude -p exited 0', probe.exitCode === 0, `exit ${probe.exitCode}: ${transcript.slice(0, 400)}`);
  check('model echoed the marker', transcript.includes(marker), transcript.slice(0, 400));

  console.log('\n[7] tmux session survives a closed terminal');
  const term = await ok(page, 'termOpen', [{ taskId: task.id, kind: 'claude', cols: 100, rows: 30 }]);
  check('terminal opened', typeof term.id === 'string' && term.id.length > 0, term.id);
  await page.waitForTimeout(6000);
  let sessions = await sh(page, task.id, "tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null");
  check('tmux session cc listed', /^cc /mu.test(sessions.stdout), sessions.stdout.trim());

  await ok(page, 'termClose', [term.id]);
  await page.waitForTimeout(2500);
  sessions = await sh(page, task.id, "tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null");
  check('session still alive after closing the tab', /^cc /mu.test(sessions.stdout), sessions.stdout.trim());
  check(
    'and its client was detached rather than left attached',
    /^cc 0$/mu.test(sessions.stdout),
    sessions.stdout.trim(),
  );

  const reattach = await ok(page, 'termOpen', [{ taskId: task.id, kind: 'claude', cols: 100, rows: 30 }]);
  await page.waitForTimeout(2500);
  sessions = await sh(page, task.id, "tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null");
  check(
    'reopening Claude Code reattaches to the same session',
    /^cc 1$/mu.test(sessions.stdout),
    sessions.stdout.trim(),
  );
  const sessionCount = sessions.stdout.split('\n').filter((line) => line.trim() !== '').length;
  check('no second tmux session was created', sessionCount === 1, String(sessionCount));
  await ok(page, 'termClose', [reattach.id]);

  console.log('\n[8] files in, files out');
  const inbox = join(scratch, 'inbox');
  mkdirSync(join(inbox, 'nested'), { recursive: true });
  writeFileSync(join(inbox, 'hello.txt'), 'hello from the host\n');
  writeFileSync(join(inbox, 'nested', 'deep.txt'), 'deep file\n');
  const imported = await ok(page, 'taskImport', [task.id, [inbox, join(inbox, 'hello.txt')]]);
  check('import reports its sources', imported.sources.length === 2, JSON.stringify(imported.sources));
  const listing = await sh(page, task.id, 'cd ~/workspace && find . -type f | sort');
  check(
    'folder import keeps its name and nesting',
    listing.stdout.includes('./inbox/nested/deep.txt') && listing.stdout.includes('./inbox/hello.txt'),
    listing.stdout.trim(),
  );
  check('file import lands at the workspace root', listing.stdout.includes('./hello.txt'), listing.stdout.trim());
  const owner = await sh(page, task.id, 'stat -c %U ~/workspace/inbox/nested/deep.txt ~/workspace/hello.txt');
  check(
    'imported files belong to claude',
    owner.stdout
      .split('\n')
      .filter(Boolean)
      .every((line) => line === 'claude'),
    owner.stdout.trim(),
  );

  const exportRoot = join(scratch, 'exports');
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, exportRoot);
  const exported = await ok(page, 'taskExport', [task.id]);
  check('export returned a path under the chosen folder', exported !== null && exported.path.startsWith(exportRoot));
  check(
    'exported nested file has the right content',
    exported !== null &&
      existsSync(join(exported.path, 'inbox/nested/deep.txt')) &&
      readFileSync(join(exported.path, 'inbox/nested/deep.txt'), 'utf8') === 'deep file\n',
  );
  check(
    'export folder is named after the task',
    exported !== null && exported.path.includes(`${TASK_PREFIX}workbench`),
  );

  console.log('\n[9] UI renders every view with a running task');
  await selectTask(page, task.id);
  await shoot(page, '02-task');
  /* oxlint-disable no-await-in-loop */
  for (const screen of ['profiles', 'extensions', 'environments', 'log', 'settings']) {
    await goView(page, screen);
    const crashed = await page.evaluate(() => document.body.innerText.trim().length === 0);
    check(`${screen} view rendered`, !crashed);
    await shoot(page, `03-${screen}`);
  }
  /* oxlint-enable no-await-in-loop */

  console.log('\n[10] delete with export');
  const deleted = await ok(page, 'taskDelete', [task.id, { exportFirst: true }]);
  session.forgetTask(task.id);
  check('delete exported first', typeof deleted.exportedTo === 'string', String(deleted.exportedTo));
  check(
    'the export holds the workspace file that was about to be destroyed',
    deleted.exportedTo !== null && existsSync(join(deleted.exportedTo, 'hello.txt')),
  );
  snapshot = await ok(page, 'snapshot');
  check('task is gone from the list', taskById(snapshot, task.id) === null);
  const gone = await call(page, 'taskExec', [task.id, { command: ['true'], asRoot: false }]);
  check('exec on the deleted task is refused', gone.ok === false, gone.ok ? 'succeeded' : gone.error);
} catch (error) {
  harnessFailure(error);
} finally {
  await session.close();
  rmSync(scratch, { recursive: true, force: true });
}

finish();
