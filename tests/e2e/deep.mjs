/**
 * Adversarial end-to-end checks.
 *
 * `workbench.mjs` walks the happy path. This one goes after the places where a
 * desktop app that talks to Docker usually breaks: typing into controlled
 * inputs, file modes and odd filenames, lifecycle transitions, and what the UI
 * does when the container is not there.
 *
 * Usage:
 *   CC_E2E_API_KEY=sk-... xvfb-run -a node tests/e2e/deep.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const API_KEY = process.env['CC_E2E_API_KEY'] ?? '';
const SCRATCH = process.env['CC_E2E_SCRATCH'] ?? '/tmp/cc-e2e-scratch';
const SHOT_DIR = process.env['CC_E2E_SCREENSHOT_DIR'] ?? '';

let failures = 0;
let step = 0;

function check(label, condition, detail = '') {
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

async function call(page, method, args = []) {
  const result = await page.evaluate(
    ([name, callArgs]) => window.cc[name](...callArgs),
    /** @type {[string, unknown[]]} */ ([method, args]),
  );
  if (result === null || typeof result !== 'object' || !('ok' in result)) {
    throw new Error(`${method}: unexpected reply ${JSON.stringify(result)}`);
  }
  return result;
}

async function ok(page, method, args = []) {
  const result = await call(page, method, args);
  if (!result.ok) throw new Error(`${method}: ${result.error}`);
  return result.value;
}

/** Clicks a sidebar tab by its index in the nav order. */
async function goTab(page, id) {
  await page.evaluate((tab) => {
    const order = ['connect', 'terminal', 'files', 'profiles', 'image', 'settings'];
    document.querySelectorAll('.sidebar button')[order.indexOf(tab)]?.click();
  }, id);
  await page.waitForTimeout(400);
}

/** Finds a text input by the label text of its `.field` wrapper. */
async function fieldInput(page, labelText) {
  const handle = await page.evaluateHandle((label) => {
    for (const field of document.querySelectorAll('.field')) {
      if (field.querySelector('label')?.textContent?.trim() === label) {
        return field.querySelector('input, textarea, select');
      }
    }
    return null;
  }, labelText);
  const element = handle.asElement();
  if (element === null) throw new Error(`no field labelled "${labelText}"`);
  return element;
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'] });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.cc === 'object' && window.cc !== null);
  await page.waitForTimeout(800);

  const boot = await ok(page, 'snapshot');
  if (!boot.docker.available) throw new Error('docker is not available');

  /* ------------------------------------------------------------------ */
  console.log('\n[A] typing into controlled inputs');
  /* ------------------------------------------------------------------ */

  await goTab(page, 'settings');
  const sessionInput = await fieldInput(page, 'tmux セッション名');
  await sessionInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('my-long-session-name', { delay: 15 });
  await page.waitForTimeout(1200);
  const typedSession = await sessionInput.inputValue();
  check(
    'settings text field keeps every character typed',
    typedSession === 'my-long-session-name',
    `got ${JSON.stringify(typedSession)}`,
  );

  // The field commits on blur, so nothing should have been written yet.
  const beforeBlur = (await ok(page, 'snapshot')).config.tmuxSession;
  check(
    'settings text field does not persist mid-edit',
    beforeBlur !== typedSession,
    `already stored ${JSON.stringify(beforeBlur)}`,
  );

  await page.keyboard.press('Tab');
  await page.waitForTimeout(700);
  const persistedSession = (await ok(page, 'snapshot')).config.tmuxSession;
  check(
    'settings text field persists on blur',
    persistedSession === typedSession,
    `stored ${JSON.stringify(persistedSession)} vs shown ${JSON.stringify(typedSession)}`,
  );
  check(
    'field still shows the committed value after the snapshot refresh',
    (await sessionInput.inputValue()) === typedSession,
  );

  // Put it back so later steps use the default session name.
  await ok(page, 'configSave', [{ tmuxSession: 'cc' }]);

  await goTab(page, 'profiles');
  const urlInput = await fieldInput(page, 'ベース URL');
  await urlInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('https://example.test/api/v1/messages', { delay: 15 });
  await page.waitForTimeout(600);
  const typedUrl = await urlInput.inputValue();
  check(
    'base URL field keeps every character while typing',
    typedUrl === 'https://example.test/api/v1/messages',
    `got ${JSON.stringify(typedUrl)}`,
  );

  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  const blurredUrl = await urlInput.inputValue();
  check(
    'base URL is trimmed to the prefix on blur',
    blurredUrl === 'https://example.test/api',
    `got ${JSON.stringify(blurredUrl)}`,
  );

  /* ------------------------------------------------------------------ */
  console.log('\n[B] container down: clear errors, no crashes');
  /* ------------------------------------------------------------------ */

  await ok(page, 'containerRemove', [true]);
  const downSnapshot = await ok(page, 'snapshot');
  check('container reported missing', downSnapshot.container.exists === false, downSnapshot.container.status);

  const provisionDown = await call(page, 'containerProvision');
  check(
    'provisioning without a container fails with a readable message',
    provisionDown.ok === false && /コンテナが起動していません|not running/u.test(provisionDown.error),
    provisionDown.ok ? 'unexpectedly succeeded' : provisionDown.error,
  );

  const listDown = await call(page, 'fsList', ['/home/claude/workspace']);
  check(
    'file listing without a container fails with a readable message',
    listDown.ok === false && /コンテナが起動していません|not running/u.test(listDown.error),
    listDown.ok ? 'unexpectedly succeeded' : listDown.error,
  );

  const termDown = await call(page, 'termOpen', [{ kind: 'shell', sessionName: 'cc', cols: 80, rows: 24 }]);
  check(
    'opening a terminal without a container fails with a readable message',
    termDown.ok === false && /コンテナが起動していません|not running/u.test(termDown.error),
    termDown.ok ? 'unexpectedly succeeded' : termDown.error,
  );

  const tmuxDown = await call(page, 'tmuxList');
  check(
    'tmux listing without a container returns empty, not an error',
    tmuxDown.ok === true && tmuxDown.value.length === 0,
  );

  // Walking tabs is inherently sequential: click, settle, assert, next.
  /* oxlint-disable no-await-in-loop */
  for (const tab of ['connect', 'terminal', 'files', 'profiles', 'settings']) {
    await goTab(page, tab);
    const painted = await page.evaluate(() => document.body.innerText.trim().length > 0);
    check(`${tab} tab still renders with no container`, painted);
  }
  /* oxlint-enable no-await-in-loop */

  /* ------------------------------------------------------------------ */
  console.log('\n[C] two profiles, switching, auth mode');
  /* ------------------------------------------------------------------ */

  await ok(page, 'containerUp');

  const bearer = {
    id: 'deep-bearer',
    name: 'Deep Bearer',
    baseUrl: 'https://openrouter.ai/api',
    authMode: 'authToken',
    model: 'stealth/ox-alpha',
    sonnetModel: 'stealth/ox-alpha',
    opusModel: 'stealth/ox-alpha',
    haikuModel: 'stealth/ox-alpha',
    apiTimeoutMs: 123456,
    contextTokens: 1048576,
    disableNonEssentialTraffic: true,
    disableTelemetry: true,
    extraEnv: { CC_DEEP_MARKER: 'bearer', ANTHROPIC_MODEL: 'stealth/ox-alpha' },
    note: 'deep test',
  };
  const keyed = {
    ...bearer,
    id: 'deep-keyed',
    name: 'Deep Keyed',
    authMode: 'apiKey',
    apiTimeoutMs: null,
    contextTokens: null,
    extraEnv: { CC_DEEP_MARKER: 'keyed' },
  };

  await ok(page, 'profileUpsert', [bearer]);
  await ok(page, 'profileUpsert', [keyed]);
  await ok(page, 'secretSet', [bearer.id, API_KEY]);
  await ok(page, 'secretSet', [keyed.id, 'sk-fake-for-header-check']);

  await ok(page, 'profileActivate', [bearer.id]);
  await ok(page, 'containerProvision');
  let env = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude/settings.json'])).env;
  check(
    'bearer profile sets AUTH_TOKEN only',
    env.ANTHROPIC_AUTH_TOKEN === API_KEY && env.ANTHROPIC_API_KEY === undefined,
  );
  check('extra env applied', env.CC_DEEP_MARKER === 'bearer', env.CC_DEEP_MARKER);
  check('API_TIMEOUT_MS applied', env.API_TIMEOUT_MS === '123456', env.API_TIMEOUT_MS);
  check('context tokens applied', env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '1048576', env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);

  await ok(page, 'profileActivate', [keyed.id]);
  await ok(page, 'containerProvision');
  env = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude/settings.json'])).env;
  check(
    'switching to api-key mode removes the stale AUTH_TOKEN',
    env.ANTHROPIC_API_KEY === 'sk-fake-for-header-check' && env.ANTHROPIC_AUTH_TOKEN === undefined,
    JSON.stringify(Object.keys(env)),
  );
  check('stale API_TIMEOUT_MS removed', env.API_TIMEOUT_MS === undefined, env.API_TIMEOUT_MS);
  check('stale context tokens removed', env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === undefined);
  check('extra env replaced, not merged', env.CC_DEEP_MARKER === 'keyed', env.CC_DEEP_MARKER);

  const claudeJson = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json']));
  check(
    'api-key mode pre-approves the key',
    Array.isArray(claudeJson.customApiKeyResponses?.approved) && claudeJson.customApiKeyResponses.approved.length > 0,
    JSON.stringify(claudeJson.customApiKeyResponses ?? null),
  );

  /* ------------------------------------------------------------------ */
  console.log('\n[D] ~/.claude.json is merged, never clobbered');
  /* ------------------------------------------------------------------ */

  const beforeMerge = { ...claudeJson, userID: 'deep-user-123', numStartups: 42 };
  beforeMerge.projects = {
    ...beforeMerge.projects,
    '/home/claude/workspace': {
      ...(beforeMerge.projects?.['/home/claude/workspace'] ?? {}),
      history: [{ display: 'earlier prompt' }],
    },
    '/some/other/project': { hasTrustDialogAccepted: false },
  };
  await ok(page, 'fsWrite', [
    { path: '/home/claude/.claude.json', content: `${JSON.stringify(beforeMerge, null, 2)}\n` },
  ]);
  await ok(page, 'containerProvision');
  const merged = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json']));
  check('unrelated top-level keys survive', merged.userID === 'deep-user-123' && merged.numStartups === 42);
  check(
    'project history survives',
    merged.projects['/home/claude/workspace'].history?.[0]?.display === 'earlier prompt',
  );
  check('other projects survive untouched', merged.projects['/some/other/project'].hasTrustDialogAccepted === false);
  check('onboarding flag re-asserted', merged.hasCompletedOnboarding === true);

  await ok(page, 'fsWrite', [{ path: '/home/claude/.claude.json', content: 'this is not json at all' }]);
  const afterCorrupt = await call(page, 'containerProvision');
  check('a corrupt .claude.json does not break provisioning', afterCorrupt.ok === true, afterCorrupt.error ?? '');
  const rebuilt = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json']));
  check('corrupt .claude.json is rebuilt with the flags', rebuilt.hasCompletedOnboarding === true);

  const badSettings = await call(page, 'fsWrite', [
    { path: '/home/claude/.claude/settings.json', content: '{ broken' },
  ]);
  check('writing an invalid settings.json is allowed', badSettings.ok === true);
  const afterBadSettings = await call(page, 'containerProvision');
  check(
    'a corrupt settings.json does not break provisioning',
    afterBadSettings.ok === true,
    afterBadSettings.error ?? '',
  );
  const settingsBack = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude/settings.json']));
  check('corrupt settings.json is rebuilt with env', typeof settingsBack.env?.ANTHROPIC_BASE_URL === 'string');

  /* ------------------------------------------------------------------ */
  console.log('\n[E] file operations');
  /* ------------------------------------------------------------------ */

  const odd = '/home/claude/workspace/日本語 と スペース.txt';
  await ok(page, 'fsWrite', [{ path: odd, content: 'ゼロ幅\tタブ\nと改行\n' }]);
  const oddBack = await ok(page, 'fsRead', [odd]);
  check('CJK + spaces in a filename round-trip', oddBack === 'ゼロ幅\tタブ\nと改行\n', JSON.stringify(oddBack));

  const listing = await ok(page, 'fsList', ['/home/claude/workspace']);
  check(
    'odd filename appears in the listing',
    listing.some((entry) => entry.name === '日本語 と スペース.txt'),
    listing.map((entry) => entry.name).join(' | '),
  );

  const nested = '/home/claude/workspace/deep/nested/dir';
  await ok(page, 'fsMkdir', [nested]);
  await ok(page, 'fsWrite', [{ path: `${nested}/inner.txt`, content: 'nested content\n' }]);
  check('nested mkdir + write works', (await ok(page, 'fsRead', [`${nested}/inner.txt`])) === 'nested content\n');

  const ownership = await ok(page, 'containerExec', [
    { command: ['stat', '-c', '%U:%G %a', odd, `${nested}/inner.txt`], asRoot: false },
  ]);
  check(
    'written files are owned by claude',
    ownership.stdout
      .split('\n')
      .filter(Boolean)
      .every((line) => line.startsWith('claude:claude')),
    ownership.stdout.trim(),
  );

  await ok(page, 'containerExec', [
    {
      command: [
        'bash',
        '-lc',
        'printf "#!/bin/sh\\necho v1\\n" > ~/workspace/script.sh && chmod 755 ~/workspace/script.sh',
      ],
      asRoot: false,
    },
  ]);
  await ok(page, 'fsWrite', [{ path: '/home/claude/workspace/script.sh', content: '#!/bin/sh\necho v2\n' }]);
  const modeAfter = await ok(page, 'containerExec', [
    { command: ['stat', '-c', '%a', '/home/claude/workspace/script.sh'], asRoot: false },
  ]);
  check(
    'editing an executable file keeps its mode',
    modeAfter.stdout.trim() === '755',
    `mode is ${modeAfter.stdout.trim()}, expected 755`,
  );

  await ok(page, 'containerExec', [
    { command: ['bash', '-lc', 'head -c 4096 /dev/urandom > ~/workspace/blob.bin'], asRoot: false },
  ]);
  const binary = await call(page, 'fsRead', ['/home/claude/workspace/blob.bin']);
  check(
    'binary files are refused with a known marker',
    binary.ok === false && binary.error === 'FILE_BINARY',
    binary.error,
  );

  await ok(page, 'containerExec', [
    {
      command: ['bash', '-lc', 'yes abcdefghijklmnopqrstuvwxyz | head -c 3000000 > ~/workspace/big.txt'],
      asRoot: false,
    },
  ]);
  const big = await call(page, 'fsRead', ['/home/claude/workspace/big.txt']);
  check(
    'oversized files are refused with a known marker',
    big.ok === false && big.error === 'FILE_TOO_LARGE',
    big.error,
  );

  const missing = await call(page, 'fsList', ['/home/claude/workspace/definitely-not-here']);
  check('listing a missing directory reports an error', missing.ok === false, missing.error ?? 'succeeded');

  /* ------------------------------------------------------------------ */
  console.log('\n[F] export');
  /* ------------------------------------------------------------------ */

  const exportRoot = join(SCRATCH, 'exports');
  mkdirSync(exportRoot, { recursive: true });
  await ok(page, 'configSave', [{ lastExportDir: exportRoot }]);
  // Answer the directory chooser without a human.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, exportRoot);

  const exported = await ok(page, 'workspaceExport');
  check('export returned a path', typeof exported === 'string' && exported.startsWith(exportRoot), String(exported));
  check('exported nested file exists on the host', existsSync(join(exported, 'deep/nested/dir/inner.txt')));
  check(
    'exported nested file has the right content',
    existsSync(join(exported, 'deep/nested/dir/inner.txt')) &&
      readFileSync(join(exported, 'deep/nested/dir/inner.txt'), 'utf8') === 'nested content\n',
  );
  check('exported CJK filename survives', existsSync(join(exported, '日本語 と スペース.txt')));
  check('no .partial directory left behind', !existsSync(`${exported}.partial`));

  const devDir = await ok(page, 'devcontainerWrite');
  check('devcontainer.json written', existsSync(join(String(devDir), 'devcontainer.json')));
  check('Dockerfile copied next to it', existsSync(join(String(devDir), 'Dockerfile')));
  const devJson = JSON.parse(readFileSync(join(String(devDir), 'devcontainer.json'), 'utf8'));
  check(
    'devcontainer points at the same volume',
    devJson.workspaceMount.includes(boot.config.volumeName),
    devJson.workspaceMount,
  );

  /* ------------------------------------------------------------------ */
  console.log('\n[G] VS Code attach URI');
  /* ------------------------------------------------------------------ */

  const vscode = await ok(page, 'containerVscode');
  const hex = /attached-container\+([0-9a-f]+)/u.exec(vscode.uri)?.[1] ?? '';
  const decoded = hex === '' ? '' : Buffer.from(hex, 'hex').toString('utf8');
  check(
    'attach URI encodes {"containerName":"/<name>"}',
    decoded === JSON.stringify({ containerName: `/${boot.config.containerName}` }),
    decoded,
  );
  check('attach URI ends at the workspace', vscode.uri.endsWith('/home/claude/workspace'), vscode.uri);

  /* ------------------------------------------------------------------ */
  console.log('\n[H] terminals');
  /* ------------------------------------------------------------------ */

  await ok(page, 'profileActivate', [bearer.id]);
  await ok(page, 'containerProvision');

  const shellA = await ok(page, 'termOpen', [{ kind: 'shell', sessionName: 'cc', cols: 80, rows: 24 }]);
  const shellB = await ok(page, 'termOpen', [{ kind: 'shell', sessionName: 'cc', cols: 100, rows: 30 }]);
  check('two shells get distinct ids', shellA.id !== shellB.id);

  const resized = await call(page, 'termResize', [shellA.id, 132, 43]);
  check('resize accepted', resized.ok === true, resized.error ?? '');
  const resizeZero = await call(page, 'termResize', [shellA.id, 0, 0]);
  check('a zero-size resize is ignored rather than throwing', resizeZero.ok === true);
  const resizeGone = await call(page, 'termResize', ['no-such-terminal', 80, 24]);
  check('resizing an unknown terminal is a no-op', resizeGone.ok === true);
  const writeGone = await call(page, 'termWrite', ['no-such-terminal', 'x']);
  check('writing to an unknown terminal is a no-op', writeGone.ok === true);
  const closeGone = await call(page, 'termClose', ['no-such-terminal']);
  check('closing an unknown terminal is a no-op', closeGone.ok === true);

  await ok(page, 'termClose', [shellA.id]);
  await ok(page, 'termClose', [shellB.id]);

  const named = await ok(page, 'termOpen', [
    { kind: 'attach', sessionName: 'has spaces.and:colons', cols: 80, rows: 24 },
  ]);
  check('tmux session names are sanitized', named.sessionName === 'has-spaces-and-colons', named.sessionName);
  await page.waitForTimeout(2500);
  const sessions = await ok(page, 'tmuxList');
  check(
    'sanitized session shows up in the list',
    sessions.some((session) => session.name === 'has-spaces-and-colons'),
    sessions.map((session) => session.name).join(', '),
  );
  await ok(page, 'termClose', [named.id]);
  await ok(page, 'tmuxKill', ['has-spaces-and-colons']);
  await page.waitForTimeout(800);
  const afterKill = await ok(page, 'tmuxList');
  check(
    'killed session is gone',
    !afterKill.some((session) => session.name === 'has-spaces-and-colons'),
    afterKill.map((session) => session.name).join(', '),
  );
  const killMissing = await call(page, 'tmuxKill', ['never-existed']);
  check('killing a missing session is not an error', killMissing.ok === true);

  /* ------------------------------------------------------------------ */
  console.log('\n[I] lifecycle and persistence');
  /* ------------------------------------------------------------------ */

  await ok(page, 'fsWrite', [{ path: '/home/claude/workspace/persist.txt', content: 'survive me\n' }]);

  const stopped = await ok(page, 'containerStop');
  check('stop reports not running', stopped.container.running === false, stopped.container.status);
  const stopAgain = await call(page, 'containerStop');
  check('stopping an already stopped container is a no-op', stopAgain.ok === true);

  const restarted = await ok(page, 'containerRestart');
  check('restart brings it back', restarted.container.running === true, restarted.container.status);
  check(
    'workspace survived the restart',
    (await ok(page, 'fsRead', ['/home/claude/workspace/persist.txt'])) === 'survive me\n',
  );

  await ok(page, 'containerRemove', [false]);
  const afterRemove = await ok(page, 'snapshot');
  check('container removed', afterRemove.container.exists === false, afterRemove.container.status);
  await ok(page, 'containerUp');
  check(
    'workspace survived removing the container (volume kept)',
    (await ok(page, 'fsRead', ['/home/claude/workspace/persist.txt'])) === 'survive me\n',
  );
  check(
    'settings.json survived removing the container',
    typeof JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude/settings.json'])).env?.ANTHROPIC_BASE_URL ===
      'string',
  );

  const upAgain = await call(page, 'containerUp');
  check('starting an already running container is a no-op', upAgain.ok === true);

  /* ------------------------------------------------------------------ */
  console.log('\n[J] image sources round-trip');
  /* ------------------------------------------------------------------ */

  const sources = await ok(page, 'imageSourcesGet');
  check('Dockerfile loaded', sources.dockerfile.includes('FROM ubuntu:24.04'));
  check('post-create loaded', sources.postCreate.includes('post-create'));

  const marked = `${sources.postCreate}\necho "DEEP-POSTCREATE-MARKER"\n`;
  await ok(page, 'imageSourcesSave', [{ dockerfile: sources.dockerfile, postCreate: marked }]);
  const reread = await ok(page, 'imageSourcesGet');
  check('post-create edit persisted', reread.postCreate.includes('DEEP-POSTCREATE-MARKER'));

  await ok(page, 'containerProvision');
  const inContainer = await ok(page, 'fsRead', ['/opt/cc/post-create.sh']);
  check('edited post-create reached the container', inContainer.includes('DEEP-POSTCREATE-MARKER'));

  await ok(page, 'imageSourcesSave', [{ dockerfile: sources.dockerfile, postCreate: 'echo start\r\nexit 3\r\n' }]);
  const crlfFree = (await ok(page, 'imageSourcesGet')).postCreate;
  check('CRLF is normalized on save', !crlfFree.includes('\r'), JSON.stringify(crlfFree));
  const failingPostCreate = await call(page, 'containerProvision');
  check(
    'a failing post-create does not fail provisioning',
    failingPostCreate.ok === true,
    failingPostCreate.error ?? '',
  );

  const restored = await ok(page, 'imageSourcesReset');
  check('reset restores the shipped sources', !restored.postCreate.includes('DEEP-POSTCREATE-MARKER'));
  check('reset keeps the Dockerfile intact', restored.dockerfile.includes('FROM ubuntu:24.04'));

  /* ------------------------------------------------------------------ */
  console.log('\n[K] language switch');
  /* ------------------------------------------------------------------ */

  await goTab(page, 'connect');
  await ok(page, 'setLanguage', ['en']);
  await page.waitForTimeout(700);
  const englishNav = await page.evaluate(() => document.querySelector('.sidebar button')?.textContent?.trim() ?? '');
  check('UI switched to English', englishNav.includes('Connect'), englishNav);
  await ok(page, 'setLanguage', ['ja']);
  await page.waitForTimeout(700);
  const japaneseNav = await page.evaluate(() => document.querySelector('.sidebar button')?.textContent?.trim() ?? '');
  check('UI switched back to Japanese', japaneseNav.includes('接続'), japaneseNav);

  if (SHOT_DIR !== '') {
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, 'deep-final.png') });
  }

  /* ------------------------------------------------------------------ */
  console.log('\n[L] cleanup of test profiles');
  /* ------------------------------------------------------------------ */

  const secretBefore = await ok(page, 'secretGet', [keyed.id]);
  check('secret readable before delete', secretBefore === 'sk-fake-for-header-check');
  await ok(page, 'profileDelete', [keyed.id]);
  const secretAfter = await ok(page, 'secretGet', [keyed.id]);
  check('deleting a profile drops its secret', secretAfter === '', JSON.stringify(secretAfter));
  await ok(page, 'profileDelete', [bearer.id]);
  const finalConfig = (await ok(page, 'snapshot')).config;
  check(
    'active profile falls back to a surviving one',
    finalConfig.activeProfileId === null || finalConfig.profiles.some((p) => p.id === finalConfig.activeProfileId),
    String(finalConfig.activeProfileId),
  );
} catch (error) {
  step += 1;
  failures += 1;
  console.error(
    `  ✗ ${String(step).padStart(2, '0')} harness — ${error instanceof Error ? error.stack : String(error)}`,
  );
} finally {
  await app.close().catch(() => undefined);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${step} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
