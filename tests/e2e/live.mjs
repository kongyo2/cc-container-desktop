import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const API_KEY = process.env['CC_E2E_API_KEY'] ?? '';
const BASE_URL = process.env['CC_E2E_BASE_URL'] ?? 'https://openrouter.ai/api';
const MODEL = process.env['CC_E2E_MODEL'] ?? 'stealth/ox-alpha';
const SHOT_DIR = process.env['CC_E2E_SCREENSHOT_DIR'] ?? '';

if (API_KEY === '') {
  console.error('CC_E2E_API_KEY is required');
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

function isTransient(text) {
  return /rate.?limit|429|50[234]|overloaded|temporarily|empty or malformed response|Provider returned error/iu.test(
    text,
  );
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/* oxlint-disable no-await-in-loop -- retry and polling loops are sequential by nature */

async function prompt(page, text, { model = '', attempts = 4 } = {}) {
  const modelFlag = model === '' ? '' : ` --model ${model}`;
  let last = { exitCode: -1, stdout: '', stderr: '' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await ok(page, 'containerExec', [
      {
        command: ['bash', '-lc', `claude --dangerously-skip-permissions${modelFlag} -p ${shellQuote(text)}`],
        asRoot: false,
      },
    ]);
    const combined = `${last.stdout}${last.stderr}`;
    if (last.exitCode === 0 || !isTransient(combined)) return last;
    console.log(`    … upstream busy, retrying (${attempt}/${attempts})`);
    await page.waitForTimeout(6000 * attempt);
  }
  return last;
}

async function focusTerminal(page) {
  await page.evaluate(() => {
    const body = [...document.querySelectorAll('.term-body')].find(
      (node) => node instanceof HTMLElement && node.style.display !== 'none',
    );
    body?.querySelector('.xterm-screen')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    body?.querySelector('.xterm-helper-textarea')?.focus();
  });
  await page.waitForTimeout(300);
}

async function terminalText(page) {
  return page.evaluate(() => {
    const bodies = [...document.querySelectorAll('.term-body')].filter(
      (node) => node instanceof HTMLElement && node.style.display !== 'none',
    );
    return bodies.map((node) => node.innerText).join('\n');
  });
}

async function waitForTerminal(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = await terminalText(page);
    if (predicate(text)) return { matched: true, text };
    await page.waitForTimeout(2000);
  }
  return { matched: false, text };
}

/* oxlint-enable no-await-in-loop */

async function shoot(page, name) {
  if (SHOT_DIR === '') return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}

const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'] });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.cc === 'object' && window.cc !== null);
  await page.waitForTimeout(800);

  console.log('\n[1] set up the endpoint');
  const snapshot = await ok(page, 'snapshot');
  const profile = {
    ...snapshot.config.profiles[0],
    id: 'live-profile',
    name: 'Live',
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
    note: 'live suite',
  };
  await ok(page, 'profileUpsert', [profile]);
  await ok(page, 'profileActivate', [profile.id]);
  await ok(page, 'secretSet', [profile.id, API_KEY]);
  await ok(page, 'containerUp');
  await ok(page, 'containerProvision');
  check('container ready', (await ok(page, 'snapshot')).container.running === true);

  console.log('\n[2] the model answers at all');
  const marker = `LIVE-${Date.now().toString(36).toUpperCase()}`;
  const echo = await prompt(page, `Reply with exactly this token and nothing else: ${marker}`);
  check('headless prompt exited 0', echo.exitCode === 0, `${echo.stderr}`.slice(0, 300));
  check('model echoed the token', `${echo.stdout}`.includes(marker), `${echo.stdout}`.slice(0, 300));

  console.log('\n[3] Claude Code can use its tools inside the container');
  await ok(page, 'containerExec', [
    { command: ['bash', '-lc', 'rm -f ~/workspace/live-tool-check.txt'], asRoot: false },
  ]);
  const toolRun = await prompt(
    page,
    'Create a file at /home/claude/workspace/live-tool-check.txt whose entire content is the single line ' +
      'TOOL-WRITE-OK. Use your file tools. Reply with DONE when the file exists.',
  );
  check('tool-use prompt exited 0', toolRun.exitCode === 0, `${toolRun.stderr}`.slice(0, 300));
  const written = await call(page, 'fsRead', ['/home/claude/workspace/live-tool-check.txt']);
  check(
    'Claude Code wrote the file through its own tools',
    written.ok === true && written.value.includes('TOOL-WRITE-OK'),
    written.ok ? JSON.stringify(written.value).slice(0, 200) : written.error,
  );

  const readBackMarker = `READ-${Date.now().toString(36).toUpperCase()}`;
  await ok(page, 'fsWrite', [
    { path: '/home/claude/workspace/live-read-check.txt', content: `secret token: ${readBackMarker}\n` },
  ]);
  const readRun = await prompt(
    page,
    'Read /home/claude/workspace/live-read-check.txt and reply with only the token it contains.',
  );
  check(
    'Claude Code read a file from the workspace',
    `${readRun.stdout}`.includes(readBackMarker),
    `${readRun.stdout}`.slice(0, 300),
  );

  const bashRun = await prompt(page, 'Run the shell command `id -un` and reply with only its output.');
  check(
    'Claude Code can run shell commands in the container',
    `${bashRun.stdout}`.includes('claude'),
    `${bashRun.stdout}`.slice(0, 200),
  );

  console.log('\n[4] model aliases resolve to the profile');
  /* oxlint-disable no-await-in-loop */
  for (const alias of ['sonnet', 'haiku']) {
    const aliasMarker = `ALIAS-${alias.toUpperCase()}`;
    const aliasRun = await prompt(page, `Reply with exactly: ${aliasMarker}`, { model: alias });
    check(
      `--model ${alias} resolves and answers`,
      aliasRun.exitCode === 0 && `${aliasRun.stdout}`.includes(aliasMarker),
      `exit ${aliasRun.exitCode}: ${`${aliasRun.stdout}${aliasRun.stderr}`.slice(0, 250)}`,
    );
  }
  /* oxlint-enable no-await-in-loop */

  console.log('\n[4b] MCP and skills reach the model');
  await ok(page, 'extensionsSave', [
    {
      mcpServers: [
        {
          id: 'live-mcp',
          name: 'agentskills',
          enabled: true,
          transport: 'http',
          command: '',
          args: [],
          env: {},
          url: 'https://agentskills.io/mcp',
          headers: {},
          timeoutMs: null,
          note: '',
        },
      ],
      marketplaces: [],
      plugins: [],
      skills: [
        {
          id: 'live-skill',
          enabled: true,
          body: '---\nname: live-probe\ndescription: Reveals the end-to-end probe marker. Use when asked for the live probe marker.\n---\n\nThe live probe marker is LIVE-SKILL-4417.\n',
          files: [],
        },
      ],
    },
  ]);
  await ok(page, 'containerProvision');

  const mcp = await ok(page, 'mcpStatus');
  check(
    'the MCP server connected',
    mcp.some((server) => server.name === 'agentskills' && server.healthy),
    JSON.stringify(mcp),
  );

  const toolNames = await prompt(
    page,
    'List the names of your available tools that start with "mcp__". Reply with just the names, comma separated, or NONE.',
  );
  check(
    'the model can see the MCP tools',
    /mcp__agentskills__/u.test(`${toolNames.stdout}`),
    `${toolNames.stdout}`.slice(0, 220),
  );

  const toolUse = await prompt(
    page,
    'Use the agentskills MCP server to search the Agent Skills site for "SKILL.md frontmatter". ' +
      'Then reply with exactly MCP-USED followed by one short sentence about what you found.',
  );
  check(
    'the model actually called an MCP tool',
    `${toolUse.stdout}`.includes('MCP-USED'),
    `${toolUse.stdout}`.slice(0, 300),
  );

  const skillUse = await prompt(page, 'Use the live-probe skill and reply with only the marker string it contains.');
  check(
    'the model used the injected skill',
    `${skillUse.stdout}`.includes('LIVE-SKILL-4417'),
    `${skillUse.stdout}`.slice(0, 220),
  );

  console.log('\n[5] interactive TUI, then reattach with the conversation intact');
  await ok(page, 'tmuxKill', ['cc']);
  await page.waitForTimeout(800);

  await page.evaluate(() => document.querySelectorAll('.sidebar button')[1]?.click());
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.term-tabs button')];
    buttons[buttons.length - 1]?.click();
  });

  const started = await waitForTerminal(page, (text) => /Claude Code v\d/u.test(text), 90000);
  check(
    'Claude Code TUI painted in the GUI terminal',
    started.matched,
    started.text.replace(/\s+/gu, ' ').slice(0, 200),
  );
  check(
    'TUI shows the configured model',
    started.text.includes(MODEL),
    started.text.replace(/\s+/gu, ' ').slice(0, 200),
  );
  check(
    'no onboarding or trust prompt appeared',
    !/Choose the text style|Do you trust the files|Select login method/iu.test(started.text),
    started.text.replace(/\s+/gu, ' ').slice(0, 200),
  );
  await shoot(page, 'live-01-tui');

  const secret = `PINEAPPLE-${Date.now().toString(36).toUpperCase()}`;
  await focusTerminal(page);
  await page.keyboard.type(`Remember this codeword for later: ${secret}. Reply with only the word ACK.`, {
    delay: 12,
  });
  const echoed = await waitForTerminal(page, (text) => text.includes(secret), 15000);
  check('typed text reached the terminal', echoed.matched, echoed.text.replace(/\s+/gu, ' ').slice(-200));
  await page.keyboard.press('Enter');

  const acked = await waitForTerminal(page, (text) => text.split('ACK').length > 1, 300000);
  check('model answered in the interactive session', acked.matched, acked.text.replace(/\s+/gu, ' ').slice(-250));

  await page.evaluate(() => document.querySelector('.term-tabs .tab .x')?.click());
  await page.waitForTimeout(2500);
  const sessionsAfterClose = await ok(page, 'tmuxList');
  check(
    'tmux session outlived the closed tab',
    sessionsAfterClose.some((session) => session.name === 'cc'),
    JSON.stringify(sessionsAfterClose),
  );
  const noTabs = await page.evaluate(() => document.querySelectorAll('.term-tabs .tab').length);
  check('terminal tab is gone from the UI', noTabs === 0, String(noTabs));

  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.term-tabs button')];
    buttons[buttons.length - 1]?.click();
  });
  const reattached = await waitForTerminal(page, (text) => text.includes(secret), 90000);
  check(
    'reattached terminal still shows the earlier conversation',
    reattached.matched,
    reattached.text.replace(/\s+/gu, ' ').slice(-250),
  );
  await shoot(page, 'live-02-reattached');

  await focusTerminal(page);
  const question = 'What codeword did I give you? Reply with only CODEWORD=<the codeword>.';
  await page.keyboard.type(question, { delay: 12 });
  const questionEchoed = await waitForTerminal(page, (text) => text.includes('CODEWORD='), 15000);
  check(
    'the recall question reached the reattached terminal',
    questionEchoed.matched,
    questionEchoed.text.replace(/\s+/gu, ' ').slice(-200),
  );
  await page.keyboard.press('Enter');

  const recalled = await waitForTerminal(page, (text) => text.includes(`CODEWORD=${secret}`), 360000);
  check(
    'the conversation continued across the reattach (model recalled the codeword)',
    recalled.matched,
    recalled.text.replace(/\s+/gu, ' ').slice(-300),
  );
  await shoot(page, 'live-03-recall');
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
