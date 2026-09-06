// The interactive path against a live endpoint: Claude Code's TUI inside a task,
// a conversation that survives a closed tab, and MCP + skills reaching the
// model. Needs Docker, a built image and CC_E2E_API_KEY.

import {
  call,
  check,
  finish,
  harnessFailure,
  isTransient,
  launchIsolated,
  ok,
  readContainerFile,
  selectTask,
  sh,
  shellQuote,
  shoot,
  taskById,
  TASK_PREFIX,
  writeContainerFile,
} from './helpers.mjs';

const API_KEY = process.env['CC_E2E_API_KEY'] ?? '';
const BASE_URL = process.env['CC_E2E_BASE_URL'] ?? 'https://openrouter.ai/api';
const MODEL = process.env['CC_E2E_MODEL'] ?? 'stealth/ox-alpha';
const LIVE_SKILL_SOURCE = '/home/claude/workspace/live-skill-source';

if (API_KEY === '') {
  console.error('CC_E2E_API_KEY is required');
  process.exit(2);
}

/* oxlint-disable no-await-in-loop -- retry and polling loops are sequential by nature */

async function prompt(page, taskId, text, { model = '', attempts = 4 } = {}) {
  const modelFlag = model === '' ? '' : ` --model ${model}`;
  let last = { exitCode: -1, stdout: '', stderr: '' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await sh(page, taskId, `claude --dangerously-skip-permissions${modelFlag} -p ${shellQuote(text)}`);
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

const session = await launchIsolated();
const { page } = session;

try {
  console.log('\n[1] set up the endpoint and a task');
  const snapshot = await ok(page, 'snapshot');
  if (!snapshot.docker.available) throw new Error('docker is not available');
  if (!snapshot.image.exists) throw new Error('the image is not built; run the workbench suite first');
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
  await ok(page, 'secretSet', [profile.id, API_KEY]);
  const created = await session.createTask({ name: `${TASK_PREFIX}live`, profileId: profile.id });
  const task = created.task;
  check('task ready', taskById(await ok(page, 'snapshot'), task.id)?.container.running === true);

  console.log('\n[2] the model answers at all');
  const marker = `LIVE-${Date.now().toString(36).toUpperCase()}`;
  const echo = await prompt(page, task.id, `Reply with exactly this token and nothing else: ${marker}`);
  check('headless prompt exited 0', echo.exitCode === 0, `${echo.stderr}`.slice(0, 300));
  check('model echoed the token', `${echo.stdout}`.includes(marker), `${echo.stdout}`.slice(0, 300));

  console.log('\n[3] Claude Code can use its tools inside the container');
  await sh(page, task.id, 'rm -f ~/workspace/live-tool-check.txt');
  const toolRun = await prompt(
    page,
    task.id,
    'Create a file at /home/claude/workspace/live-tool-check.txt whose entire content is the single line ' +
      'TOOL-WRITE-OK. Use your file tools. Reply with DONE when the file exists.',
  );
  check('tool-use prompt exited 0', toolRun.exitCode === 0, `${toolRun.stderr}`.slice(0, 300));
  const written = await sh(page, task.id, 'cat ~/workspace/live-tool-check.txt');
  check(
    'Claude Code wrote the file through its own tools',
    written.exitCode === 0 && written.stdout.includes('TOOL-WRITE-OK'),
    written.stdout.slice(0, 200),
  );

  const readBackMarker = `READ-${Date.now().toString(36).toUpperCase()}`;
  await writeContainerFile(
    page,
    task.id,
    '/home/claude/workspace/live-read-check.txt',
    `secret token: ${readBackMarker}\n`,
  );
  const readRun = await prompt(
    page,
    task.id,
    'Read /home/claude/workspace/live-read-check.txt and reply with only the token it contains.',
  );
  check(
    'Claude Code read a file from the workspace',
    `${readRun.stdout}`.includes(readBackMarker),
    `${readRun.stdout}`.slice(0, 300),
  );

  const bashRun = await prompt(page, task.id, 'Run the shell command `id -un` and reply with only its output.');
  check(
    'Claude Code can run shell commands in the container',
    `${bashRun.stdout}`.includes('claude'),
    `${bashRun.stdout}`.slice(0, 200),
  );

  console.log('\n[4] model aliases resolve to the profile');
  /* oxlint-disable no-await-in-loop */
  for (const alias of ['sonnet', 'haiku']) {
    const aliasMarker = `ALIAS-${alias.toUpperCase()}`;
    const aliasRun = await prompt(page, task.id, `Reply with exactly: ${aliasMarker}`, { model: alias });
    check(
      `--model ${alias} resolves and answers`,
      aliasRun.exitCode === 0 && `${aliasRun.stdout}`.includes(aliasMarker),
      `exit ${aliasRun.exitCode}: ${`${aliasRun.stdout}${aliasRun.stderr}`.slice(0, 250)}`,
    );
  }
  /* oxlint-enable no-await-in-loop */

  console.log('\n[5] MCP and skills reach the model');
  await sh(
    page,
    task.id,
    `mkdir -p ${LIVE_SKILL_SOURCE}/live-probe && printf '%s\\n' '---' 'name: live-probe' ` +
      `'description: Reveals the end-to-end probe marker. Use when asked for the live probe marker.' '---' '' ` +
      `'The live probe marker is LIVE-SKILL-4417.' > ${LIVE_SKILL_SOURCE}/live-probe/SKILL.md`,
  );
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
      skillInstalls: [{ id: 'live-skill', enabled: true, source: LIVE_SKILL_SOURCE, skills: ['live-probe'], note: '' }],
    },
  ]);
  await ok(page, 'taskProvision', [task.id]);

  const mcp = await ok(page, 'taskMcpStatus', [task.id]);
  check(
    'the MCP server connected',
    mcp.some((server) => server.name === 'agentskills' && server.healthy),
    JSON.stringify(mcp),
  );

  const toolNames = await prompt(
    page,
    task.id,
    'List the names of your available tools that start with "mcp__". Reply with just the names, comma separated, or NONE.',
  );
  check(
    'the model can see the MCP tools',
    /mcp__agentskills__/u.test(`${toolNames.stdout}`),
    `${toolNames.stdout}`.slice(0, 220),
  );

  const toolUse = await prompt(
    page,
    task.id,
    'Use the agentskills MCP server to search the Agent Skills site for "SKILL.md frontmatter". ' +
      'Then reply with exactly MCP-USED followed by one short sentence about what you found.',
  );
  check(
    'the model actually called an MCP tool',
    `${toolUse.stdout}`.includes('MCP-USED'),
    `${toolUse.stdout}`.slice(0, 300),
  );

  const skillUse = await prompt(
    page,
    task.id,
    'Use the live-probe skill and reply with only the marker string it contains.',
  );
  check(
    'the model used the installed skill',
    `${skillUse.stdout}`.includes('LIVE-SKILL-4417'),
    `${skillUse.stdout}`.slice(0, 220),
  );
  check(
    'the skill file is where the CLI put it',
    (await readContainerFile(page, task.id, '/home/claude/.claude/skills/live-probe/SKILL.md')).includes(
      'LIVE-SKILL-4417',
    ),
  );

  console.log('\n[6] interactive TUI, then reattach with the conversation intact');
  await sh(page, task.id, 'tmux kill-server 2>/dev/null; true');
  await selectTask(page, task.id);
  await page.click('[data-testid="open-claude"]');

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
  await page.keyboard.type(`Remember this codeword for later: ${secret}. Reply with only the word ACK.`, { delay: 12 });
  const echoed = await waitForTerminal(page, (text) => text.includes(secret), 15000);
  check('typed text reached the terminal', echoed.matched, echoed.text.replace(/\s+/gu, ' ').slice(-200));
  await page.keyboard.press('Enter');

  const acked = await waitForTerminal(page, (text) => text.split('ACK').length > 1, 300000);
  check('model answered in the interactive session', acked.matched, acked.text.replace(/\s+/gu, ' ').slice(-250));

  await page.evaluate(() => document.querySelector('.term-tabs .tab .x')?.click());
  await page.waitForTimeout(2500);
  const afterClose = await sh(page, task.id, "tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null");
  check('tmux session outlived the closed tab', /^cc /mu.test(afterClose.stdout), afterClose.stdout.trim());
  check('closing the tab detached its tmux client', /^cc 0$/mu.test(afterClose.stdout), afterClose.stdout.trim());
  const noTabs = await page.evaluate(() => document.querySelectorAll('.term-tabs .tab').length);
  check('terminal tab is gone from the UI', noTabs === 0, String(noTabs));

  await page.click('[data-testid="open-claude"]');
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

  console.log('\n[7] the task survives the app itself');
  await page.evaluate(() => document.querySelector('.term-tabs .tab .x')?.click());
  await page.waitForTimeout(1500);
  const stillRunning = await call(page, 'taskExec', [
    task.id,
    { command: ['tmux', 'has-session', '-t', 'cc'], asRoot: false },
  ]);
  check(
    'the tmux session is still there for the next attach',
    stillRunning.ok === true && stillRunning.value.exitCode === 0,
  );
} catch (error) {
  harnessFailure(error);
} finally {
  await session.close();
}

finish();
