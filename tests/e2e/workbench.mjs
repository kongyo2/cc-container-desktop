import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const API_KEY = process.env['CC_E2E_API_KEY'] ?? '';
const BASE_URL = process.env['CC_E2E_BASE_URL'] ?? 'https://openrouter.ai/api';
const MODEL = process.env['CC_E2E_MODEL'] ?? 'stealth/ox-alpha';
const SHOT_DIR = process.env['CC_E2E_SCREENSHOT_DIR'] ?? '';
const SKIP_BUILD = process.env['CC_E2E_SKIP_BUILD'] === '1';

if (API_KEY === '') {
  console.error('CC_E2E_API_KEY is required');
  process.exit(2);
}

let failures = 0;
let step = 0;

function ok(label, detail = '') {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2, '0')} ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

function fail(label, detail) {
  step += 1;
  failures += 1;
  console.error(`  ✗ ${String(step).padStart(2, '0')} ${label} — ${detail}`);
}

function check(label, condition, detail = '') {
  if (condition) ok(label, detail);
  else fail(label, detail === '' ? 'assertion failed' : detail);
  return condition;
}

async function call(page, method, args = []) {
  const result = await page.evaluate(([name, callArgs]) => window.cc[name](...callArgs), [method, args]);
  if (result === null || typeof result !== 'object' || !('ok' in result)) {
    throw new Error(`${method}: unexpected reply ${JSON.stringify(result)}`);
  }
  if (!result.ok) throw new Error(`${method}: ${result.error}`);
  return result.value;
}

function isTransient(text) {
  return /rate.?limit|429|50[234]|overloaded|temporarily|empty or malformed response|Provider returned error/iu.test(
    text,
  );
}

async function shoot(page, name) {
  if (SHOT_DIR === '') return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false });
}

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.cc === 'object' && window.cc !== null);

  console.log('\n[1] app + docker');
  const bridged = await page.evaluate(() => Object.keys(window.cc).length);
  check('preload bridge exposed', bridged > 25, `${bridged} methods`);

  let snapshot = await call(page, 'snapshot');
  check('docker reachable', snapshot.docker.available === true, snapshot.docker.error ?? `v${snapshot.docker.version}`);
  check(
    'starter profile present',
    snapshot.config.profiles.length >= 1,
    `${snapshot.config.profiles.length} profile(s)`,
  );
  await shoot(page, '01-connect');

  console.log('\n[2] image');
  if (!SKIP_BUILD) {
    await call(page, 'imageBuild', [{ noCache: false }]);
  }
  snapshot = await call(page, 'snapshot');
  check('image exists', snapshot.image.exists === true, snapshot.image.tag);

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
  await call(page, 'profileUpsert', [profile]);
  await call(page, 'profileActivate', [profile.id]);
  await call(page, 'secretSet', [profile.id, API_KEY]);
  const readBack = await call(page, 'secretGet', [profile.id]);
  check('credential round-trips through the store', readBack === API_KEY, `${readBack.length} chars`);

  console.log('\n[4] container + provisioning');
  snapshot = await call(page, 'containerUp');
  check('container running', snapshot.container.running === true, snapshot.container.status);

  const summary = await call(page, 'containerProvision');
  check('provision reported success', typeof summary === 'string' && summary.includes(MODEL), summary);

  const claudeJson = JSON.parse(await call(page, 'fsRead', ['/home/claude/.claude.json']));
  check('hasCompletedOnboarding is true', claudeJson.hasCompletedOnboarding === true);
  check(
    'workspace is trusted',
    claudeJson.projects?.['/home/claude/workspace']?.hasTrustDialogAccepted === true,
    JSON.stringify(claudeJson.projects ?? {}),
  );

  const settings = JSON.parse(await call(page, 'fsRead', ['/home/claude/.claude/settings.json']));
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
  await call(page, 'fsWrite', [
    { path: '/home/claude/.claude/settings.json', content: `${JSON.stringify(withExtra, null, 2)}\n` },
  ]);
  await call(page, 'containerProvision');
  const reProvisioned = JSON.parse(await call(page, 'fsRead', ['/home/claude/.claude/settings.json']));
  check('hand-added keys preserved', reProvisioned.statusLine?.command === 'echo hi');
  check('env still correct', reProvisioned.env?.ANTHROPIC_MODEL === MODEL);

  console.log('\n[6] Claude Code answers over the endpoint');
  const marker = `E2E-${Date.now().toString(36).toUpperCase()}`;
  let probe = { exitCode: -1, stdout: '', stderr: '' };
  /* oxlint-disable no-await-in-loop */
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    probe = await call(page, 'containerExec', [
      {
        command: [
          'bash',
          '-lc',
          `node /opt/cc/onboard.cjs && claude --dangerously-skip-permissions -p 'Reply with exactly this token and nothing else: ${marker}'`,
        ],
        asRoot: false,
      },
    ]);
    if (probe.exitCode === 0 || !isTransient(`${probe.stdout}${probe.stderr}`)) break;
    console.log(`    … upstream busy, retrying (${attempt}/4)`);
    await page.waitForTimeout(6000 * attempt);
  }
  /* oxlint-enable no-await-in-loop */
  const transcript = `${probe.stdout}${probe.stderr}`.trim();
  check('claude -p exited 0', probe.exitCode === 0, `exit ${probe.exitCode}: ${transcript.slice(0, 400)}`);
  check('model echoed the marker', transcript.includes(marker), transcript.slice(0, 400));

  console.log('\n[7] tmux session survives a detached terminal');
  const term = await call(page, 'termOpen', [{ kind: 'claude', sessionName: 'cc', cols: 100, rows: 30 }]);
  check('terminal opened', typeof term.id === 'string' && term.id.length > 0, term.sessionName);
  await page.waitForTimeout(6000);
  let sessions = await call(page, 'tmuxList');
  check(
    'tmux session listed',
    sessions.some((s) => s.name === 'cc'),
    JSON.stringify(sessions),
  );

  await call(page, 'termClose', [term.id]);
  await page.waitForTimeout(1500);
  sessions = await call(page, 'tmuxList');
  check(
    'session still alive after closing the tab (reattach works)',
    sessions.some((s) => s.name === 'cc'),
    JSON.stringify(sessions),
  );

  const reattach = await call(page, 'termOpen', [{ kind: 'attach', sessionName: 'cc', cols: 100, rows: 30 }]);
  check('reattached to the same session', reattach.sessionName === 'cc');
  await call(page, 'termClose', [reattach.id]);

  console.log('\n[8] UI renders every tab');
  /* oxlint-disable no-await-in-loop */
  for (const [tab, label] of [
    ['terminal', '02-terminal'],
    ['files', '03-files'],
    ['profiles', '04-profiles'],
    ['extensions', '04b-extensions'],
    ['image', '05-image'],
    ['settings', '06-settings'],
    ['connect', '07-connect'],
  ]) {
    await page.evaluate((id) => {
      const buttons = [...document.querySelectorAll('.sidebar button')];
      const order = ['connect', 'terminal', 'files', 'profiles', 'extensions', 'image', 'settings'];
      buttons[order.indexOf(id)]?.click();
    }, tab);
    await page.waitForTimeout(900);
    const crashed = await page.evaluate(() => document.body.innerText.trim().length === 0);
    check(`${tab} tab rendered`, !crashed);
    await shoot(page, label);
  }
  /* oxlint-enable no-await-in-loop */

  console.log('\n[9] export');
  await call(page, 'containerExec', [
    { command: ['bash', '-lc', 'echo hello-from-container > /home/claude/workspace/e2e.txt'], asRoot: false },
  ]);
  const listing = await call(page, 'fsList', ['/home/claude/workspace']);
  check(
    'file browser sees the new file',
    listing.some((entry) => entry.name === 'e2e.txt'),
    listing.map((entry) => entry.name).join(', '),
  );
} catch (error) {
  fail('harness', error instanceof Error ? error.message : String(error));
} finally {
  await app.close().catch(() => undefined);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${step} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
