import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const API_KEY = process.env['CC_E2E_API_KEY'] ?? '';
const SCRATCH = process.env['CC_E2E_SCRATCH'] ?? '/tmp/cc-e2e-scratch';
const SHOT_DIR = process.env['CC_E2E_SCREENSHOT_DIR'] ?? '';

const LOCAL_SKILL_SOURCE = '/home/claude/workspace/deep-skill-source';

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
  const result = await page.evaluate(([name, callArgs]) => window.cc[name](...callArgs), [method, args]);
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

async function goTab(page, id) {
  await page.evaluate((tab) => {
    const order = ['connect', 'terminal', 'files', 'profiles', 'extensions', 'image', 'settings'];
    document.querySelectorAll('.sidebar button')[order.indexOf(tab)]?.click();
  }, id);
  await page.waitForTimeout(400);
}

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

  await page.evaluate(() => {
    window.__ccBuildLogs = [];
    window.__ccProvisionLogs = [];
    window.cc.onLog((line) => {
      if (line.stream === 'build') window.__ccBuildLogs.push(line.text);
      if (line.stream === 'provision') window.__ccProvisionLogs.push(line.text);
    });
  });

  console.log('\n[A] typing into controlled inputs');

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

  console.log('\n[B] container down: clear errors, no crashes');

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

  /* oxlint-disable no-await-in-loop */
  for (const tab of ['connect', 'terminal', 'files', 'profiles', 'extensions', 'settings']) {
    await goTab(page, tab);
    const painted = await page.evaluate(() => document.body.innerText.trim().length > 0);
    check(`${tab} tab still renders with no container`, painted);
  }
  /* oxlint-enable no-await-in-loop */

  console.log('\n[C] two profiles, switching, auth mode');

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
    fableModel: 'stealth/ox-alpha',
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
    'bearer profile sets AUTH_TOKEN and explicitly blanks API_KEY',
    env.ANTHROPIC_AUTH_TOKEN === API_KEY && env.ANTHROPIC_API_KEY === '',
  );
  check('extra env applied', env.CC_DEEP_MARKER === 'bearer', env.CC_DEEP_MARKER);
  check(
    'the fable alias is pinned for the gateway',
    env.ANTHROPIC_DEFAULT_FABLE_MODEL === 'stealth/ox-alpha',
    env.ANTHROPIC_DEFAULT_FABLE_MODEL,
  );
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

  console.log('\n[D] ~/.claude.json is merged, never clobbered');

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

  console.log('\n[E] file operations');

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

  console.log('\n[F] export');

  const exportRoot = join(SCRATCH, 'exports');
  mkdirSync(exportRoot, { recursive: true });
  await ok(page, 'configSave', [{ lastExportDir: exportRoot }]);
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

  console.log('\n[G] VS Code attach URI');

  const vscode = await ok(page, 'containerVscode');
  const hex = /attached-container\+([0-9a-f]+)/u.exec(vscode.uri)?.[1] ?? '';
  const decoded = hex === '' ? '' : Buffer.from(hex, 'hex').toString('utf8');
  check(
    'attach URI encodes {"containerName":"/<name>"}',
    decoded === JSON.stringify({ containerName: `/${boot.config.containerName}` }),
    decoded,
  );
  check('attach URI ends at the workspace', vscode.uri.endsWith('/home/claude/workspace'), vscode.uri);

  console.log('\n[H] terminals');

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

  const wide = await ok(page, 'termOpen', [{ kind: 'shell', sessionName: 'cc', cols: 200, rows: 50 }]);
  await page.evaluate((id) => {
    window.__ccTermText = '';
    window.cc.onTerminalData((event) => {
      if (event.id === id) window.__ccTermText += event.data;
    });
  }, wide.id);
  await page.waitForTimeout(600);
  const REPEATS = 20000;
  await ok(page, 'termWrite', [wide.id, `printf 'あ%.0s' $(seq 1 ${REPEATS}); printf '\\nDONE-CJK\\n'\n`]);
  await page.waitForTimeout(9000);
  const termText = await page.evaluate(() => window.__ccTermText ?? '');
  check(
    'a 60KB run of 3-byte characters survives the pty stream intact',
    !termText.includes('�'),
    `${(termText.match(/�/gu) ?? []).length} replacement char(s) in ${termText.length}`,
  );
  check(
    'and every character arrived',
    (termText.match(/あ/gu) ?? []).length >= REPEATS,
    `${(termText.match(/あ/gu) ?? []).length}/${REPEATS}`,
  );
  await ok(page, 'termClose', [wide.id]);

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
  check(
    'the listing carries tmux session ids',
    sessions.every((session) => /^\$\d+$/u.test(session.id)),
    sessions.map((session) => session.id).join(', '),
  );
  check(
    'an open tab shows as attached',
    sessions.find((session) => session.name === 'has-spaces-and-colons')?.attached === true,
  );

  await ok(page, 'termClose', [named.id]);
  await page.waitForTimeout(2500);
  const afterDetach = await ok(page, 'tmuxList');
  const detached = afterDetach.find((session) => session.name === 'has-spaces-and-colons');
  check('closing the tab leaves the session running', detached !== undefined);
  check('and detaches its client instead of leaking one', detached?.attached === false, JSON.stringify(afterDetach));

  const leaked = await ok(page, 'containerExec', [
    { command: ['bash', '-lc', 'tmux list-clients 2>/dev/null | wc -l'], asRoot: false },
  ]);
  check('no tmux client is left behind', leaked.stdout.trim() === '0', leaked.stdout.trim());

  const raced = await ok(page, 'termOpen', [{ kind: 'attach', sessionName: 'raced', cols: 80, rows: 24 }]);
  await ok(page, 'termClose', [raced.id]);
  await page.waitForTimeout(4000);
  const afterRace = await ok(page, 'containerExec', [
    { command: ['bash', '-lc', 'tmux list-clients 2>/dev/null | wc -l'], asRoot: false },
  ]);
  check(
    'closing a tab the instant it opens still detaches its client',
    afterRace.stdout.trim() === '0',
    afterRace.stdout.trim(),
  );
  await ok(page, 'tmuxKill', ['raced']);

  const injected = await ok(page, 'termOpen', [
    { kind: 'attach', sessionName: 'pwn#(touch /tmp/cc-pwned)#{pid}*x', cols: 80, rows: 24 },
  ]);
  check(
    'tmux format and glob characters never reach tmux',
    !/[#{}*?[\]$@%:.=~\\\s]/u.test(injected.sessionName),
    injected.sessionName,
  );
  await page.waitForTimeout(2500);
  const injectedList = await ok(page, 'tmuxList');
  check(
    'tmux agrees on the name we reported back',
    injectedList.some((session) => session.name === injected.sessionName),
    injectedList.map((session) => session.name).join(', '),
  );
  const pwned = await ok(page, 'containerExec', [
    { command: ['bash', '-lc', 'test -e /tmp/cc-pwned && echo yes || echo no'], asRoot: false },
  ]);
  check('a session name cannot run a command in the container', pwned.stdout.trim() === 'no', pwned.stdout.trim());
  await ok(page, 'termClose', [injected.id]);
  await page.waitForTimeout(1500);

  await ok(page, 'tmuxKill', [injected.sessionName]);
  await page.waitForTimeout(800);

  const prefixKill = await call(page, 'tmuxKill', ['has']);
  check('killing a mere prefix of a session name is a no-op', prefixKill.ok === true);
  await page.waitForTimeout(800);
  const afterPrefixKill = await ok(page, 'tmuxList');
  check(
    'and the session sharing that prefix is still there',
    afterPrefixKill.some((session) => session.name === 'has-spaces-and-colons'),
    afterPrefixKill.map((session) => session.name).join(', '),
  );

  const killTarget = afterPrefixKill.find((session) => session.name === 'has-spaces-and-colons');
  await ok(page, 'tmuxKill', [killTarget.id]);
  await page.waitForTimeout(800);
  const afterKill = await ok(page, 'tmuxList');
  check(
    'killing by session id works',
    !afterKill.some((session) => session.name === 'has-spaces-and-colons'),
    afterKill.map((session) => session.name).join(', '),
  );
  const killMissing = await call(page, 'tmuxKill', ['never-existed']);
  check('killing a missing session is not an error', killMissing.ok === true);

  const staleRow = await ok(page, 'termOpen', [{ kind: 'attach', sessionName: 'renamed', cols: 80, rows: 24 }]);
  await page.waitForTimeout(2500);
  const staleEntry = (await ok(page, 'tmuxList')).find((session) => session.name === 'renamed');
  await ok(page, 'containerExec', [
    { command: ['bash', '-lc', `tmux rename-session -t '${staleEntry.id}' someone-elses-work`], asRoot: false },
  ]);
  const staleKill = await call(page, 'tmuxKill', [staleEntry.id, 'renamed']);
  check('killing by a stale id whose session now has another name is refused', staleKill.ok === false);
  const spared = await ok(page, 'tmuxList');
  check(
    'and that session is left running',
    spared.some((session) => session.name === 'someone-elses-work'),
    spared.map((session) => session.name).join(', '),
  );
  await ok(page, 'termClose', [staleRow.id]);
  await ok(page, 'tmuxKill', ['someone-elses-work']);
  const attachGone = await call(page, 'termOpen', [
    { kind: 'attach', sessionName: 'ghost', sessionId: '$999', cols: 80, rows: 24 },
  ]);
  check('attaching to a session that has gone reports it instead of making a new one', attachGone.ok === false);

  const doomed = await ok(page, 'termOpen', [{ kind: 'attach', sessionName: 'doomed', cols: 80, rows: 24 }]);
  await page.waitForTimeout(2500);
  const doomedEntry = (await ok(page, 'tmuxList')).find((session) => session.name === 'doomed');
  await ok(page, 'containerExec', [
    { command: ['bash', '-lc', `tmux kill-session -t '${doomedEntry.id}'`], asRoot: false },
  ]);
  const killRaced = await call(page, 'tmuxKill', [doomedEntry.id]);
  check('a session that ended between listing and kill is not reported as a failure', killRaced.ok === true);
  await ok(page, 'termClose', [doomed.id]);

  const firstTab = await ok(page, 'termOpen', [{ kind: 'attach', sessionName: 'reused', cols: 80, rows: 24 }]);
  await page.waitForTimeout(2500);
  await ok(page, 'containerExec', [{ command: ['bash', '-lc', "tmux detach-client -s 'reused'"], asRoot: false }]);
  const reattached = await ok(page, 'termOpen', [{ kind: 'attach', sessionName: 'reused', cols: 80, rows: 24 }]);
  await page.waitForTimeout(4000);
  const afterReattach = await ok(page, 'tmuxList');
  check(
    'cleanup for a tab that ended on its own does not detach the tab that replaced it',
    afterReattach.find((session) => session.name === 'reused')?.attached === true,
    JSON.stringify(afterReattach),
  );
  await ok(page, 'termClose', [firstTab.id]);
  await ok(page, 'termClose', [reattached.id]);
  await ok(page, 'tmuxKill', ['reused']);

  await ok(page, 'containerProvision');
  await ok(page, 'containerProvision');
  const features = await ok(page, 'containerExec', [
    { command: ['bash', '-lc', 'tmux show -g terminal-features 2>/dev/null | grep -cF "xterm*:RGB"'], asRoot: false },
  ]);
  check(
    'reloading the managed config does not stack terminal-features entries',
    features.stdout.trim() === '1',
    features.stdout.trim(),
  );

  console.log('\n[I] lifecycle and persistence');

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

  console.log('\n[J] image sources round-trip');

  const sources = await ok(page, 'imageSourcesGet');
  check('Dockerfile loaded', sources.dockerfile.includes('FROM ubuntu:24.04'));
  check('post-create loaded', sources.postCreate.includes('post-create'));
  check('setup script loaded', sources.setup.includes('setup'), sources.setup.slice(0, 60));

  const marked = `${sources.postCreate}\necho "DEEP-POSTCREATE-MARKER"\n`;
  await ok(page, 'imageSourcesSave', [{ dockerfile: sources.dockerfile, setup: sources.setup, postCreate: marked }]);
  const reread = await ok(page, 'imageSourcesGet');
  check('post-create edit persisted', reread.postCreate.includes('DEEP-POSTCREATE-MARKER'));

  await ok(page, 'containerProvision');
  const inContainer = await ok(page, 'fsRead', ['/opt/cc/post-create.sh']);
  check('edited post-create reached the container', inContainer.includes('DEEP-POSTCREATE-MARKER'));

  await ok(page, 'imageSourcesSave', [
    { dockerfile: sources.dockerfile, setup: sources.setup, postCreate: 'echo start\r\nexit 3\r\n' },
  ]);
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

  console.log('\n[K] image build path');

  const scratchTag = 'cc-container-desktop-e2e:scratch';
  const realTag = (await ok(page, 'snapshot')).config.imageTag;
  const savedSources = await ok(page, 'imageSourcesGet');

  try {
    await ok(page, 'configSave', [{ imageTag: scratchTag }]);

    await ok(page, 'imageSourcesSave', [
      {
        dockerfile: 'FROM ubuntu:24.04\nRUN exit 42\n',
        setup: savedSources.setup,
        postCreate: savedSources.postCreate,
      },
    ]);
    const failedBuild = await call(page, 'imageBuild', [{ noCache: false }]);
    check(
      'a failing build is reported as an error',
      failedBuild.ok === false && /42/u.test(failedBuild.error),
      failedBuild.ok ? 'unexpectedly succeeded' : failedBuild.error,
    );

    writeFileSync(join(savedSources.dir, 'extra-context-file.txt'), 'CONTEXT-OK\n');
    await ok(page, 'imageSourcesSave', [
      {
        dockerfile:
          'FROM ubuntu:24.04\n' +
          'COPY extra-context-file.txt /tmp/extra.txt\n' +
          'RUN grep -q CONTEXT-OK /tmp/extra.txt\n' +
          'COPY setup.sh /opt/cc/setup.sh\n' +
          'RUN bash /opt/cc/setup.sh\n',
        setup: 'echo SETUP-RAN-AT-BUILD\n',
        postCreate: savedSources.postCreate,
      },
    ]);
    const contextBuild = await call(page, 'imageBuild', [{ noCache: false }]);
    check(
      'a user-added file reaches the build context',
      contextBuild.ok === true,
      contextBuild.ok ? '' : contextBuild.error,
    );

    await page.waitForTimeout(600);
    const buildLogs = await page.evaluate(() => window.__ccBuildLogs ?? []);
    check('build progress was streamed to the log pane', buildLogs.length > 3, `${buildLogs.length} lines`);
    check(
      'the log reports completion',
      buildLogs.some((line) => /build finished|ビルド完了/u.test(line)),
      buildLogs.slice(-2).join(' | '),
    );

    check(
      'setup.sh runs at build time, so its output is in the build log',
      buildLogs.some((line) => line.includes('SETUP-RAN-AT-BUILD')),
      buildLogs.filter((line) => line.includes('SETUP')).join(' | ') || '(not found)',
    );

    const scratchImage = await ok(page, 'snapshot');
    check('the scratch image exists', scratchImage.image.exists === true, scratchImage.image.tag);
  } finally {
    rmSync(join(savedSources.dir, 'extra-context-file.txt'), { force: true });
    await ok(page, 'imageSourcesSave', [
      { dockerfile: savedSources.dockerfile, setup: savedSources.setup, postCreate: savedSources.postCreate },
    ]);
    await ok(page, 'configSave', [{ imageTag: realTag }]);
    try {
      execFileSync('docker', ['rmi', '-f', scratchTag], { stdio: 'ignore' });
    } catch {}
  }

  console.log('\n[L] language switch');

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

  console.log('\n[M] extensions: MCP, marketplaces, plugins, skill installs');

  await ok(page, 'containerUp');

  await ok(page, 'containerExec', [
    {
      command: [
        'bash',
        '-lc',
        'mkdir -p ~/.claude/skills/hand-written && echo "hand made" > ~/.claude/skills/hand-written/SKILL.md',
      ],
      asRoot: false,
    },
  ]);

  await ok(page, 'containerExec', [
    {
      command: [
        'bash',
        '-lc',
        `mkdir -p ${LOCAL_SKILL_SOURCE}/deep-probe && printf '%s\\n' '---' 'name: deep-probe' ` +
          `'description: A probe skill the end-to-end suite installs to prove the skills CLI ran.' '---' '' ` +
          `'DEEP-SKILL-MARKER' > ${LOCAL_SKILL_SOURCE}/deep-probe/SKILL.md`,
      ],
      asRoot: false,
    },
  ]);
  const handMadeJson = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json']));
  handMadeJson.mcpServers = {
    ...(handMadeJson.mcpServers ?? {}),
    'hand-added': { type: 'http', url: 'https://example.test/mcp' },
  };
  await ok(page, 'fsWrite', [
    { path: '/home/claude/.claude.json', content: `${JSON.stringify(handMadeJson, null, 2)}\n` },
  ]);

  await ok(page, 'extensionsSave', [
    {
      mcpServers: [
        {
          id: 'x-remote',
          name: 'agentskills',
          enabled: true,
          transport: 'http',
          command: '',
          args: [],
          env: {},
          url: 'https://agentskills.io/mcp',
          headers: { 'X-Probe': ' spaced ' },
          timeoutMs: 30000,
          note: '',
        },
        {
          id: 'x-stdio',
          name: 'local_fs',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/claude/workspace'],
          env: { DEBUG: '1' },
          url: '',
          headers: {},
          timeoutMs: null,
          note: '',
        },
        {
          id: 'x-off',
          name: 'disabled_one',
          enabled: false,
          transport: 'http',
          command: '',
          args: [],
          env: {},
          url: 'https://disabled.test/mcp',
          headers: {},
          timeoutMs: null,
          note: '',
        },
        {
          id: 'x-bad-name',
          name: 'has.dots',
          enabled: true,
          transport: 'http',
          command: '',
          args: [],
          env: {},
          url: 'https://bad.test/mcp',
          headers: {},
          timeoutMs: null,
          note: '',
        },
        {
          id: 'x-reserved',
          name: 'workspace',
          enabled: true,
          transport: 'http',
          command: '',
          args: [],
          env: {},
          url: 'https://reserved.test/mcp',
          headers: {},
          timeoutMs: null,
          note: '',
        },
      ],
      marketplaces: [
        {
          id: 'x-mkt',
          name: 'acme-tools',
          enabled: true,
          sourceKind: 'github',
          repo: 'acme-corp/claude-plugins',
          url: '',
          autoUpdate: true,
        },
      ],
      plugins: [
        { id: 'x-plg-on', plugin: 'formatter', marketplace: 'acme-tools', enabled: true },
        { id: 'x-plg-off', plugin: 'experimental', marketplace: 'acme-tools', enabled: false },
      ],
      skillInstalls: [
        { id: 'x-skill-local', enabled: true, source: LOCAL_SKILL_SOURCE, skills: ['deep-probe'], note: '' },
        { id: 'x-skill-remote', enabled: true, source: 'anthropics/skills', skills: ['frontend-design'], note: '' },
        { id: 'x-skill-off', enabled: false, source: 'never/installed', skills: [], note: '' },
        { id: 'x-skill-bad', enabled: true, source: '', skills: [], note: '' },
      ],
    },
  ]);
  await ok(page, 'containerProvision');

  const servers = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json'])).mcpServers;
  check(
    'a remote server carries an explicit type',
    servers.agentskills?.type === 'http' && servers.agentskills?.url === 'https://agentskills.io/mcp',
    JSON.stringify(servers.agentskills),
  );
  check(
    'header whitespace is trimmed',
    servers.agentskills?.headers?.['X-Probe'] === 'spaced',
    JSON.stringify(servers.agentskills?.headers),
  );
  check('the per-server timeout is written', servers.agentskills?.timeout === 30000);
  check(
    'a stdio server is written the way `claude mcp add` writes it',
    servers.local_fs?.command === 'npx' && servers.local_fs?.args?.length === 3 && servers.local_fs?.type === 'stdio',
    JSON.stringify(servers.local_fs),
  );
  check('stdio env is written', servers.local_fs?.env?.DEBUG === '1');
  check('a disabled server is not written', servers.disabled_one === undefined);
  check('an invalid name is refused', servers['has.dots'] === undefined);
  check('a reserved name is refused', servers.workspace === undefined);
  check(
    'a server added inside the container is left alone',
    servers['hand-added']?.url === 'https://example.test/mcp',
    JSON.stringify(servers['hand-added']),
  );

  const extSettings = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude/settings.json']));
  check(
    'the marketplace is registered',
    extSettings.extraKnownMarketplaces?.['acme-tools']?.source?.repo === 'acme-corp/claude-plugins',
    JSON.stringify(extSettings.extraKnownMarketplaces),
  );
  check('autoUpdate is carried through', extSettings.extraKnownMarketplaces?.['acme-tools']?.autoUpdate === true);
  check(
    'plugins are keyed as plugin@marketplace, both states kept',
    extSettings.enabledPlugins?.['formatter@acme-tools'] === true &&
      extSettings.enabledPlugins?.['experimental@acme-tools'] === false,
    JSON.stringify(extSettings.enabledPlugins),
  );

  const localSkill = await ok(page, 'fsRead', ['/home/claude/.claude/skills/deep-probe/SKILL.md']);
  check('the skills CLI installed the named skill', localSkill.includes('DEEP-SKILL-MARKER'));
  const remoteSkill = await call(page, 'fsRead', ['/home/claude/.claude/skills/frontend-design/SKILL.md']);
  check(
    'a skill named with -s is installed from a GitHub source',
    remoteSkill.ok === true,
    remoteSkill.ok ? '' : remoteSkill.error,
  );
  const ranCommand = await page.evaluate(() =>
    window.__ccProvisionLogs.some((line) =>
      line.includes('npx -y skills@latest add anthropics/skills -s frontend-design -g -a claude-code -y'),
    ),
  );
  check('the command runs exactly as the panel shows it', ranCommand);
  const notInstalled = await call(page, 'fsRead', ['/home/claude/.claude/skills/never-installed/SKILL.md']);
  check('a disabled entry is not installed', notInstalled.ok === false);
  const emptySourceWarned = await page.evaluate(() =>
    window.__ccProvisionLogs.some((line) => line.includes('ソースが空です')),
  );
  check('an entry with no source is reported, not run', emptySourceWarned);
  const handSkill = await ok(page, 'fsRead', ['/home/claude/.claude/skills/hand-written/SKILL.md']);
  check('a hand-written skill is left alone', handSkill.includes('hand made'));

  await ok(page, 'containerProvision');
  const stillThere = await ok(page, 'fsRead', ['/home/claude/.claude/skills/deep-probe/SKILL.md']);
  check('a second apply reinstalls over the same skill', stillThere.includes('DEEP-SKILL-MARKER'));

  const extBeforeBadEdit = (await ok(page, 'snapshot')).config.extensions;
  await ok(page, 'extensionsSave', [
    {
      ...extBeforeBadEdit,
      mcpServers: extBeforeBadEdit.mcpServers.map((server) =>
        server.name === 'agentskills' ? { ...server, url: '' } : server,
      ),
    },
  ]);
  await ok(page, 'containerProvision');
  const preserved = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json'])).mcpServers;
  check(
    'an invalid edit to a managed server keeps its last applied config',
    preserved.agentskills?.url === 'https://agentskills.io/mcp',
    JSON.stringify(preserved.agentskills),
  );

  await ok(page, 'configSave', [{ autoOnboarding: false }]);
  const extNoOnboard = (await ok(page, 'snapshot')).config.extensions;
  await ok(page, 'extensionsSave', [
    {
      ...extNoOnboard,
      mcpServers: [
        ...extNoOnboard.mcpServers,
        {
          id: 'x-late',
          name: 'late_join',
          enabled: true,
          transport: 'http',
          command: '',
          args: [],
          env: {},
          url: 'https://late.test/mcp',
          headers: {},
          timeoutMs: null,
          note: '',
        },
      ],
    },
  ]);
  await ok(page, 'containerProvision');
  const lateServers = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json'])).mcpServers;
  check(
    'MCP servers still install with auto-onboarding off',
    lateServers.late_join?.url === 'https://late.test/mcp',
    JSON.stringify(lateServers.late_join),
  );
  await ok(page, 'configSave', [{ autoOnboarding: true }]);

  await ok(page, 'extensionsSave', [{ mcpServers: [], marketplaces: [], plugins: [], skillInstalls: [] }]);
  await ok(page, 'containerProvision');
  const afterRemoval = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json'])).mcpServers;
  check(
    'removing a server removes it from the container',
    afterRemoval.agentskills === undefined,
    JSON.stringify(afterRemoval),
  );
  check('the hand-added server still survives', afterRemoval['hand-added']?.url === 'https://example.test/mcp');
  const settingsAfter = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude/settings.json']));
  check('removing a marketplace removes it', settingsAfter.extraKnownMarketplaces?.['acme-tools'] === undefined);
  check('removing a plugin removes it', settingsAfter.enabledPlugins?.['formatter@acme-tools'] === undefined);
  const keptSkill = await call(page, 'fsRead', ['/home/claude/.claude/skills/deep-probe/SKILL.md']);
  check('dropping an entry leaves the installed skill in the container', keptSkill.ok === true);
  const stillThereSkill = await call(page, 'fsRead', ['/home/claude/.claude/skills/hand-written/SKILL.md']);
  check('the hand-written skill is still there', stillThereSkill.ok === true);

  console.log('\n[N] reset: a disposable session');

  await ok(page, 'containerUp');
  await ok(page, 'containerProvision');

  await ok(page, 'containerExec', [
    {
      command: [
        'bash',
        '-lc',
        'sudo install -m 0755 /dev/stdin /usr/local/bin/reset-probe <<<"#!/bin/sh\necho GLOBAL-MARKER" && ' +
          'echo HOME-MARKER > ~/.reset-probe && ' +
          'echo WORKSPACE-MARKER > ~/workspace/reset-probe.txt',
      ],
      asRoot: false,
    },
  ]);

  const before = await ok(page, 'containerExec', [
    { command: ['bash', '-lc', 'reset-probe; cat ~/.reset-probe ~/workspace/reset-probe.txt'], asRoot: false },
  ]);
  check(
    'all three markers are in place before the reset',
    ['GLOBAL-MARKER', 'HOME-MARKER', 'WORKSPACE-MARKER'].every((marker) => before.stdout.includes(marker)),
    before.stdout.replace(/\s+/gu, ' ').trim(),
  );

  const containerBefore = (await ok(page, 'snapshot')).container.id;
  const imageBefore = (await ok(page, 'snapshot')).image.id;

  await ok(page, 'termOpen', [{ kind: 'shell', sessionName: 'cc', cols: 80, rows: 24 }]);
  await page.waitForTimeout(1200);

  const resetExportDir = join(SCRATCH, 'reset-exports');
  mkdirSync(resetExportDir, { recursive: true });
  await ok(page, 'configSave', [{ lastExportDir: resetExportDir }]);

  const summary = await ok(page, 'containerReset', [{ exportFirst: true, rebuildImage: false }]);
  check('reset reported a fresh container', typeof summary.containerName === 'string', summary.containerName);
  check('reset exported first', typeof summary.exportedTo === 'string', String(summary.exportedTo));
  check(
    'the export holds the workspace file that was about to be destroyed',
    existsSync(join(String(summary.exportedTo), 'reset-probe.txt')) &&
      readFileSync(join(String(summary.exportedTo), 'reset-probe.txt'), 'utf8').includes('WORKSPACE-MARKER'),
  );

  const afterReset = await ok(page, 'snapshot');
  check('container is running again', afterReset.container.running === true, afterReset.container.status);
  check('it is a different container', afterReset.container.id !== containerBefore);
  check(
    'the image is untouched — it is the snapshot',
    afterReset.image.id === imageBefore,
    String(afterReset.image.id),
  );

  const after = await ok(page, 'containerExec', [
    {
      command: [
        'bash',
        '-lc',
        'command -v reset-probe || echo NO-GLOBAL; cat ~/.reset-probe 2>/dev/null || echo NO-HOME; ' +
          'cat ~/workspace/reset-probe.txt 2>/dev/null || echo NO-WORKSPACE',
      ],
      asRoot: false,
    },
  ]);
  check('the globally installed binary is gone', after.stdout.includes('NO-GLOBAL'), after.stdout.trim());
  check('the home-directory file is gone', after.stdout.includes('NO-HOME'), after.stdout.trim());
  check('the workspace file is gone', after.stdout.includes('NO-WORKSPACE'), after.stdout.trim());

  check(
    'Claude Code is still installed — it came from the image',
    /\d+\.\d+\.\d+/u.test(
      (await ok(page, 'containerExec', [{ command: ['claude', '--version'], asRoot: false }])).stdout,
    ),
  );

  const freshSettings = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude/settings.json']));
  check(
    'the fresh container was provisioned',
    typeof freshSettings.env?.ANTHROPIC_BASE_URL === 'string',
    JSON.stringify(Object.keys(freshSettings.env ?? {})),
  );
  check(
    'the bypass-permissions prompt is pre-accepted where current Claude Code reads it',
    freshSettings.skipDangerousModePermissionPrompt === true,
  );
  const freshClaudeJson = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json']));
  check('onboarding is done in the fresh container', freshClaudeJson.hasCompletedOnboarding === true);

  await page.waitForTimeout(600);
  const tabsAfterReset = await page.evaluate(() => document.querySelectorAll('.term-tabs .tab').length);
  check('terminal tabs were dropped with the container', tabsAfterReset === 0, String(tabsAfterReset));

  const sessionsAfterReset = await ok(page, 'tmuxList');
  check('no tmux sessions survived', sessionsAfterReset.length === 0, JSON.stringify(sessionsAfterReset));

  console.log('\n[O] the guards that stand between a typo and lost data');

  await ok(page, 'configSave', [{ lastExportDir: null }]);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await ok(page, 'fsWrite', [{ path: '/home/claude/workspace/guard-probe.txt', content: 'STILL-HERE\n' }]);
  const refused = await call(page, 'containerReset', [{ exportFirst: true, rebuildImage: false }]);
  check('a reset that cannot export refuses instead of destroying', refused.ok === false, JSON.stringify(refused));
  const survived = await call(page, 'fsRead', ['/home/claude/workspace/guard-probe.txt']);
  check(
    'the workspace it was about to destroy is still there',
    survived.ok === true && survived.value.includes('STILL-HERE'),
    survived.ok ? survived.value : survived.error,
  );

  const beforeBadPlugin = (await ok(page, 'snapshot')).config;
  await ok(page, 'extensionsSave', [
    {
      ...beforeBadPlugin.extensions,
      plugins: [{ id: 'plg_blank', plugin: '', marketplace: '', enabled: true }],
    },
  ]);
  const afterBadPlugin = (await ok(page, 'snapshot')).config;
  check(
    'a half-typed plugin does not take the profiles with it',
    afterBadPlugin.profiles.length === beforeBadPlugin.profiles.length,
    `${beforeBadPlugin.profiles.length} → ${afterBadPlugin.profiles.length}`,
  );
  check(
    'and the config still round-trips through its own schema',
    JSON.parse(JSON.stringify(afterBadPlugin)).version === 1,
    String(afterBadPlugin.version),
  );

  const protectedSkill = 'handmade-guard';
  await ok(page, 'containerExec', [
    {
      command: [
        'bash',
        '-lc',
        `mkdir -p ~/.claude/skills/${protectedSkill} && echo MINE > ~/.claude/skills/${protectedSkill}/SKILL.md`,
      ],
      asRoot: false,
    },
  ]);
  await ok(page, 'extensionsSave', [
    {
      mcpServers: [
        {
          id: 'mcp_proto',
          name: 'constructor',
          enabled: true,
          transport: 'http',
          command: '',
          args: [],
          env: {},
          url: 'https://example.test/proto',
          headers: {},
          timeoutMs: null,
          note: '',
        },
      ],
      marketplaces: [],
      plugins: [],
      skillInstalls: [
        { id: 'skl_dashed', enabled: true, source: '-rf', skills: [], note: '' },
        { id: 'skl_spaced', enabled: true, source: 'has space/repo', skills: [], note: '' },
        { id: 'skl_dashed_name', enabled: true, source: 'acme/skills', skills: ['-g'], note: '' },
      ],
    },
  ]);
  await ok(page, 'containerProvision');

  const handmade = await ok(page, 'fsRead', [`/home/claude/.claude/skills/${protectedSkill}/SKILL.md`]);
  check('a skill directory the app never installed is left alone', handmade.trim() === 'MINE', handmade.trim());
  await ok(page, 'containerProvision');
  const handmadeSecond = await ok(page, 'fsRead', [`/home/claude/.claude/skills/${protectedSkill}/SKILL.md`]);
  check('and a second provision still does not touch it', handmadeSecond.trim() === 'MINE', handmadeSecond.trim());
  const refusedArgs = await page.evaluate(() => [
    ...new Set(
      window.__ccProvisionLogs.filter(
        (line) => line.includes('- で始まっています') || line.includes('空白は使えません'),
      ),
    ),
  ]);
  check(
    'a source or skill name that would be read as an option is refused',
    refusedArgs.length === 3,
    JSON.stringify(refusedArgs),
  );
  const neverRan = await page.evaluate(() =>
    window.__ccProvisionLogs.some((line) => line.includes('npx -y skills@latest add -rf')),
  );
  check('and its command never runs', neverRan === false);

  const withProto = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json']));
  check(
    'a server named after an Object.prototype member is written',
    Object.hasOwn(withProto.mcpServers ?? {}, 'constructor'),
    JSON.stringify(Object.keys(withProto.mcpServers ?? {})),
  );
  await ok(page, 'extensionsSave', [{ mcpServers: [], marketplaces: [], plugins: [], skillInstalls: [] }]);
  await ok(page, 'containerProvision');
  const withoutProto = JSON.parse(await ok(page, 'fsRead', ['/home/claude/.claude.json']));
  check(
    'and removing it actually removes it',
    !Object.hasOwn(withoutProto.mcpServers ?? {}, 'constructor'),
    JSON.stringify(Object.keys(withoutProto.mcpServers ?? {})),
  );
  const handmadeAfterClear = await call(page, 'fsRead', [`/home/claude/.claude/skills/${protectedSkill}/SKILL.md`]);
  check(
    'clearing the extensions does not delete the never-claimed skill',
    handmadeAfterClear.ok === true && handmadeAfterClear.value.trim() === 'MINE',
    handmadeAfterClear.ok ? handmadeAfterClear.value.trim() : handmadeAfterClear.error,
  );

  await ok(page, 'containerExec', [
    { command: ['bash', '-lc', 'ln -sfn /etc/hostname ~/workspace/a-link'], asRoot: false },
  ]);
  const linkRead = await call(page, 'fsRead', ['/home/claude/workspace/a-link']);
  check(
    'opening a symlink reports a problem instead of an empty editor',
    linkRead.ok === false,
    linkRead.ok ? JSON.stringify(linkRead.value) : linkRead.error,
  );

  const badScheme = await call(page, 'openExternal', ['file:///etc/passwd']);
  check('a non-http link is refused', badScheme.ok === false, JSON.stringify(badScheme));
  const badReveal = await call(page, 'revealPath', ['/etc']);
  check('revealing a path outside the app data is refused', badReveal.ok === false, JSON.stringify(badReveal));

  const guardConfig = (await ok(page, 'snapshot')).config;
  await ok(page, 'containerRemove', [false]);
  execFileSync('docker', ['create', '--name', guardConfig.containerName, guardConfig.imageTag], { stdio: 'ignore' });
  try {
    const adopted = await call(page, 'containerUp');
    check(
      'a same-name container the app did not create is refused, not adopted',
      adopted.ok === false && adopted.error.includes(guardConfig.containerName),
      JSON.stringify(adopted),
    );
  } finally {
    execFileSync('docker', ['rm', '-f', guardConfig.containerName], { stdio: 'ignore' });
  }
  await ok(page, 'containerUp');

  console.log('\n[P] cleanup of test profiles');

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
