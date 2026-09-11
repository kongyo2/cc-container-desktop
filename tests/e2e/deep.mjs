import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  call,
  check,
  finish,
  goView,
  harnessFailure,
  launchIsolated,
  ok,
  readContainerFile,
  readContainerJson,
  selectTask,
  sh,
  shoot,
  taskById,
  TASK_PREFIX,
  waitFor,
  writeContainerFile,
} from './helpers.mjs';

const API_KEY = process.env['CC_E2E_API_KEY'] ?? 'sk-e2e-placeholder-token';
const LOCAL_SKILL_SOURCE = '/home/claude/workspace/deep-skill-source';
const SCRATCH_TAG = 'cc-container-desktop-e2e:scratch';

const scratch = mkdtempSync(join(tmpdir(), 'cc-deep-'));
const session = await launchIsolated();
const { page, app } = session;

async function fieldInput(labelText) {
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

function mockDirectoryDialog(dir) {
  return app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () =>
      chosen === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [chosen] };
  }, dir);
}

function dockerLabelsOf(containerName) {
  const raw = execFileSync('docker', ['inspect', '--format', '{{json .Config.Labels}}', containerName], {
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

function dockerInspectSucceeds(argv) {
  try {
    execFileSync('docker', argv, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function dockerVolumeExists(name) {
  return dockerInspectSucceeds(['volume', 'inspect', name]);
}

function dockerContainerExists(name) {
  return dockerInspectSucceeds(['inspect', '--type', 'container', name]);
}

try {
  const boot = await ok(page, 'snapshot');
  if (!boot.docker.available) throw new Error('docker is not available');
  if (!boot.image.exists) {
    console.log('  … image missing, building it first');
    await ok(page, 'imageBuild', [{ noCache: false, refreshClaudeCode: false }]);
  }
  const defaultEnvironmentId = boot.config.defaultEnvironmentId;

  await page.evaluate(() => {
    window.__ccBuildLogs = [];
    window.__ccProvisionLogs = [];
    window.__ccSetupLogs = [];
    window.__ccAppLogs = [];
    window.__ccResets = [];
    window.cc.onLog((line) => {
      if (line.stream === 'build') window.__ccBuildLogs.push(line.text);
      if (line.stream === 'provision') window.__ccProvisionLogs.push(line.text);
      if (line.stream === 'setup') window.__ccSetupLogs.push(line.text);
      if (line.stream === 'app') window.__ccAppLogs.push(line.text);
    });
    window.cc.onTerminalsReset((reset) => window.__ccResets.push(reset.taskId));
  });

  console.log('\n[A] guards that need no container');

  const unknownKey = await call(page, 'configSave', [{ containerName: 'x' }]);
  check('a config key that no longer exists is rejected', unknownKey.ok === false, unknownKey.error ?? '');
  const emptyTag = await call(page, 'configSave', [{ imageTag: '   ' }]);
  check('an empty image tag is rejected', emptyTag.ok === false, emptyTag.error ?? '');
  check(
    'a fresh config seeds exactly one environment and makes it the default',
    boot.config.environments.length === 1 && boot.config.environments[0].id === defaultEnvironmentId,
  );
  const ghostDefault = await ok(page, 'configSave', [{ defaultEnvironmentId: 'ghost' }]);
  check(
    'an unknown default environment falls back to a real one',
    ghostDefault.defaultEnvironmentId === defaultEnvironmentId,
  );
  const badEnvName = await call(page, 'environmentUpsert', [
    { id: 'e2e-env', name: '   ', envText: '', setupScript: '' },
  ]);
  check('an environment needs a name', badEnvName.ok === false, badEnvName.error ?? '');
  const badVarName = await call(page, 'environmentUpsert', [
    { id: 'e2e-env', name: 'x', envText: '1BAD=1', setupScript: '' },
  ]);
  check('an invalid variable name is refused', badVarName.ok === false, badVarName.error ?? '');
  const badVarLine = await call(page, 'environmentUpsert', [
    { id: 'e2e-env', name: 'x', envText: 'not a pair', setupScript: '' },
  ]);
  check('a line that is not KEY=VALUE is refused', badVarLine.ok === false, badVarLine.error ?? '');
  const extraEnvKey = await call(page, 'environmentUpsert', [
    { id: 'e2e-env', name: 'x', envText: '', setupScript: '', archived: true },
  ]);
  check('an environment draft with extra keys is refused', extraEnvKey.ok === false);
  const reservedName = await call(page, 'environmentUpsert', [
    { id: 'e2e-env', name: 'x', envText: 'HOME=/elsewhere', setupScript: '' },
  ]);
  check('a variable the app sets itself is refused', reservedName.ok === false, reservedName.error ?? '');
  const archiveNoFlag = await call(page, 'environmentArchive', [defaultEnvironmentId, 'true']);
  check('a non-boolean archive state is refused', archiveNoFlag.ok === false);
  const unknownEnvironment = await call(page, 'taskCreate', [
    { name: 'x', note: '', profileId: null, environmentId: 'no-such-env', source: { kind: 'empty' } },
  ]);
  check('an unknown environment is refused', unknownEnvironment.ok === false, unknownEnvironment.error ?? '');
  const archiveGhost = await call(page, 'environmentArchive', ['no-such-env', true]);
  check('archiving an unknown environment is an error', archiveGhost.ok === false);

  const noName = await call(page, 'taskCreate', [
    { name: '   ', note: '', profileId: null, source: { kind: 'empty' } },
  ]);
  check('a task needs a name', noName.ok === false, noName.error ?? '');
  const sshUrl = await call(page, 'taskCreate', [
    { name: 'x', note: '', profileId: null, source: { kind: 'git', url: 'git@github.com:a/b.git', ref: '' } },
  ]);
  check('an ssh clone URL is refused', sshUrl.ok === false, sshUrl.error ?? '');
  const credUrl = await call(page, 'taskCreate', [
    {
      name: 'x',
      note: '',
      profileId: null,
      source: { kind: 'git', url: 'https://user:token@github.com/a/b', ref: '' },
    },
  ]);
  check('credentials in a clone URL are refused', credUrl.ok === false, credUrl.error ?? '');
  const optionRef = await call(page, 'taskCreate', [
    {
      name: 'x',
      note: '',
      profileId: null,
      source: { kind: 'git', url: 'https://github.com/a/b', ref: '--upload-pack=x' },
    },
  ]);
  check('a branch that reads as an option is refused', optionRef.ok === false, optionRef.error ?? '');
  const badProfile = await call(page, 'taskCreate', [
    { name: 'x', note: '', profileId: 'no-such-profile', source: { kind: 'empty' } },
  ]);
  check('an unknown profile is refused', badProfile.ok === false, badProfile.error ?? '');
  check('none of the refused creations left a task behind', (await ok(page, 'snapshot')).tasks.length === 0);

  const execGhost = await call(page, 'taskExec', ['ghost', { command: ['true'], asRoot: false }]);
  check('exec on an unknown task is refused', execGhost.ok === false, execGhost.error ?? '');
  const termGhost = await call(page, 'termOpen', [{ taskId: 'ghost', kind: 'shell', cols: 80, rows: 24 }]);
  check('a terminal on an unknown task is refused', termGhost.ok === false, termGhost.error ?? '');
  const badScheme = await call(page, 'openExternal', ['file:///etc/passwd']);
  check('a non-http link is refused', badScheme.ok === false);
  const badReveal = await call(page, 'revealPath', ['/etc']);
  check('revealing a path outside the app data is refused', badReveal.ok === false);

  console.log('\n[B] typing into controlled inputs');

  await page.click('[data-testid="new-task"]');
  await page.waitForTimeout(400);
  const nameInput = await fieldInput('タスク名');
  await nameInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('my long task name', { delay: 15 });
  await page.waitForTimeout(400);
  check('the task name field keeps every character typed', (await nameInput.inputValue()) === 'my long task name');
  const createEnabled = await page.evaluate(() => !document.querySelector('[data-testid="create-task"]').disabled);
  check('the create button is enabled with a valid form', createEnabled);
  await nameInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  const createDisabled = await page.evaluate(() => document.querySelector('[data-testid="create-task"]').disabled);
  check('the create button is disabled with an empty name', createDisabled);

  await goView(page, 'profiles');
  const urlInput = await fieldInput('ベース URL');
  await urlInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('https://example.test/api/v1/messages', { delay: 15 });
  await page.waitForTimeout(400);
  check(
    'base URL field keeps every character while typing',
    (await urlInput.inputValue()) === 'https://example.test/api/v1/messages',
  );
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  check('base URL is trimmed to the prefix on blur', (await urlInput.inputValue()) === 'https://example.test/api');

  console.log('\n[C] two tasks, two profiles, nothing shared');

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

  const alpha = (await session.createTask({ name: `${TASK_PREFIX}alpha`, profileId: bearer.id })).task;
  const beta = (await session.createTask({ name: `${TASK_PREFIX}beta`, profileId: keyed.id, note: '  beta note ' }))
    .task;
  check('tasks get distinct containers', alpha.containerName !== beta.containerName);
  check('the note is trimmed', beta.note === 'beta note', JSON.stringify(beta.note));

  let snapshot = await ok(page, 'snapshot');
  check(
    'both tasks are running',
    taskById(snapshot, alpha.id)?.container.running && taskById(snapshot, beta.id)?.container.running,
  );
  check(
    'each container carries its own task label',
    dockerLabelsOf(alpha.containerName)['com.cc-container-desktop.task'] === alpha.id &&
      dockerLabelsOf(beta.containerName)['com.cc-container-desktop.task'] === beta.id,
  );
  check(
    'each task has its own home volume',
    dockerVolumeExists(alpha.volumeName) && dockerVolumeExists(beta.volumeName),
  );

  let alphaEnv = (await readContainerJson(page, alpha.id, '/home/claude/.claude/settings.json')).env;
  let betaEnv = (await readContainerJson(page, beta.id, '/home/claude/.claude/settings.json')).env;
  check(
    'the bearer task sets AUTH_TOKEN and explicitly blanks API_KEY',
    alphaEnv.ANTHROPIC_AUTH_TOKEN === API_KEY && alphaEnv.ANTHROPIC_API_KEY === '',
  );
  check('extra env applied per task', alphaEnv.CC_DEEP_MARKER === 'bearer' && betaEnv.CC_DEEP_MARKER === 'keyed');
  check('the fable alias is pinned for the gateway', alphaEnv.ANTHROPIC_DEFAULT_FABLE_MODEL === 'stealth/ox-alpha');
  check('API_TIMEOUT_MS applied', alphaEnv.API_TIMEOUT_MS === '123456', alphaEnv.API_TIMEOUT_MS);
  check('context tokens applied', alphaEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '1048576');
  check(
    'the keyed task uses the API key header and no stale AUTH_TOKEN',
    betaEnv.ANTHROPIC_API_KEY === 'sk-fake-for-header-check' && betaEnv.ANTHROPIC_AUTH_TOKEN === undefined,
    JSON.stringify(Object.keys(betaEnv)),
  );
  check(
    'no timeout leaks into the keyed task',
    betaEnv.API_TIMEOUT_MS === undefined && betaEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS === undefined,
  );
  const betaClaudeJson = await readContainerJson(page, beta.id, '/home/claude/.claude.json');
  check(
    'api-key mode pre-approves the key',
    Array.isArray(betaClaudeJson.customApiKeyResponses?.approved) &&
      betaClaudeJson.customApiKeyResponses.approved.length > 0,
  );

  await writeContainerFile(page, alpha.id, '/home/claude/workspace/only-in-alpha.txt', 'alpha\n');
  const betaSees = await sh(page, beta.id, 'test -e ~/workspace/only-in-alpha.txt && echo yes || echo no');
  check('a file written in one task is invisible to the other', betaSees.stdout.trim() === 'no');

  await ok(page, 'configSave', [{ defaultProfileId: keyed.id }]);
  await ok(page, 'taskProvision', [alpha.id]);
  alphaEnv = (await readContainerJson(page, alpha.id, '/home/claude/.claude/settings.json')).env;
  check('changing the default profile does not touch a task that has its own', alphaEnv.CC_DEEP_MARKER === 'bearer');

  const switched = await ok(page, 'taskUpdate', [alpha.id, { profileId: keyed.id }]);
  check('taskUpdate returns the task with the new profile', switched.profileId === keyed.id);
  alphaEnv = (await readContainerJson(page, alpha.id, '/home/claude/.claude/settings.json')).env;
  check(
    'switching a running task to api-key mode rewrites its env and drops AUTH_TOKEN',
    alphaEnv.ANTHROPIC_API_KEY === 'sk-fake-for-header-check' && alphaEnv.ANTHROPIC_AUTH_TOKEN === undefined,
  );
  check('stale API_TIMEOUT_MS removed', alphaEnv.API_TIMEOUT_MS === undefined);
  check('extra env replaced, not merged', alphaEnv.CC_DEEP_MARKER === 'keyed');
  await ok(page, 'taskUpdate', [alpha.id, { profileId: bearer.id }]);

  const renamed = await ok(page, 'taskUpdate', [alpha.id, { name: `  ${TASK_PREFIX}alpha   renamed ` }]);
  check('a rename collapses whitespace', renamed.name === `${TASK_PREFIX}alpha renamed`, JSON.stringify(renamed.name));
  const blankRename = await call(page, 'taskUpdate', [alpha.id, { name: '   ' }]);
  check('a blank rename is refused', blankRename.ok === false);
  await ok(page, 'taskUpdate', [alpha.id, { name: `${TASK_PREFIX}alpha` }]);

  const applied = await ok(page, 'profileApply', [bearer.id]);
  check(
    'applying a profile reports the running tasks that use it',
    applied.length === 1 && applied[0].startsWith(`${TASK_PREFIX}alpha`),
    JSON.stringify(applied),
  );
  const appliedNone = await ok(page, 'profileApply', ['no-such-profile']);
  check('applying an unused profile reports nothing', appliedNone.length === 0);

  console.log('\n[D] ~/.claude.json is merged, never clobbered');

  const alphaJson = await readContainerJson(page, alpha.id, '/home/claude/.claude.json');
  const beforeMerge = { ...alphaJson, userID: 'deep-user-123', numStartups: 42 };
  beforeMerge.projects = {
    ...beforeMerge.projects,
    '/home/claude/workspace': {
      ...(beforeMerge.projects?.['/home/claude/workspace'] ?? {}),
      history: [{ display: 'earlier prompt' }],
    },
    '/some/other/project': { hasTrustDialogAccepted: false },
  };
  await writeContainerFile(page, alpha.id, '/home/claude/.claude.json', `${JSON.stringify(beforeMerge, null, 2)}\n`);
  await ok(page, 'taskProvision', [alpha.id]);
  const merged = await readContainerJson(page, alpha.id, '/home/claude/.claude.json');
  check('unrelated top-level keys survive', merged.userID === 'deep-user-123' && merged.numStartups === 42);
  check(
    'project history survives',
    merged.projects['/home/claude/workspace'].history?.[0]?.display === 'earlier prompt',
  );
  check('other projects survive untouched', merged.projects['/some/other/project'].hasTrustDialogAccepted === false);
  check('onboarding flag re-asserted', merged.hasCompletedOnboarding === true);

  await writeContainerFile(page, alpha.id, '/home/claude/.claude.json', 'this is not json at all');
  const afterCorrupt = await call(page, 'taskProvision', [alpha.id]);
  check('a corrupt .claude.json does not break provisioning', afterCorrupt.ok === true, afterCorrupt.error ?? '');
  const rebuilt = await readContainerJson(page, alpha.id, '/home/claude/.claude.json');
  check('corrupt .claude.json is rebuilt with the flags', rebuilt.hasCompletedOnboarding === true);

  await writeContainerFile(page, alpha.id, '/home/claude/.claude/settings.json', '{ broken');
  const afterBadSettings = await call(page, 'taskProvision', [alpha.id]);
  check(
    'a corrupt settings.json does not break provisioning',
    afterBadSettings.ok === true,
    afterBadSettings.error ?? '',
  );
  const settingsBack = await readContainerJson(page, alpha.id, '/home/claude/.claude/settings.json');
  check('corrupt settings.json is rebuilt with env', typeof settingsBack.env?.ANTHROPIC_BASE_URL === 'string');
  check(
    'the bypass-permissions prompt is pre-accepted where current Claude Code reads it',
    settingsBack.skipDangerousModePermissionPrompt === true,
  );

  console.log('\n[E] extensions: MCP, marketplaces, plugins, skill installs');

  await sh(
    page,
    alpha.id,
    'mkdir -p ~/.claude/skills/hand-written && echo "hand made" > ~/.claude/skills/hand-written/SKILL.md',
  );
  await sh(
    page,
    alpha.id,
    `mkdir -p ${LOCAL_SKILL_SOURCE}/deep-probe && printf '%s\\n' '---' 'name: deep-probe' ` +
      `'description: A probe skill the end-to-end suite installs to prove the skills CLI ran.' '---' '' ` +
      `'DEEP-SKILL-MARKER' > ${LOCAL_SKILL_SOURCE}/deep-probe/SKILL.md`,
  );
  const handMadeJson = await readContainerJson(page, alpha.id, '/home/claude/.claude.json');
  handMadeJson.mcpServers = {
    ...(handMadeJson.mcpServers ?? {}),
    'hand-added': { type: 'http', url: 'https://example.test/mcp' },
  };
  await writeContainerFile(page, alpha.id, '/home/claude/.claude.json', `${JSON.stringify(handMadeJson, null, 2)}\n`);

  const mcp = (id, name, extra) => ({
    id,
    name,
    enabled: true,
    transport: 'http',
    command: '',
    args: [],
    env: {},
    url: '',
    headers: {},
    timeoutMs: null,
    note: '',
    ...extra,
  });
  await ok(page, 'extensionsSave', [
    {
      mcpServers: [
        mcp('x-remote', 'agentskills', {
          url: 'https://agentskills.io/mcp',
          headers: { 'X-Probe': ' spaced ' },
          timeoutMs: 30000,
        }),
        mcp('x-stdio', 'local_fs', {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/claude/workspace'],
          env: { DEBUG: '1' },
        }),
        mcp('x-off', 'disabled_one', { enabled: false, url: 'https://disabled.test/mcp' }),
        mcp('x-bad-name', 'has.dots', { url: 'https://bad.test/mcp' }),
        mcp('x-reserved', 'workspace', { url: 'https://reserved.test/mcp' }),
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
        { id: 'x-skill-off', enabled: false, source: 'never/installed', skills: [], note: '' },
        { id: 'x-skill-bad', enabled: true, source: '', skills: [], note: '' },
      ],
    },
  ]);
  const appliedAll = await ok(page, 'extensionsApply');
  check('applying extensions reaches every running task', appliedAll.length === 2, JSON.stringify(appliedAll));

  const servers = (await readContainerJson(page, alpha.id, '/home/claude/.claude.json')).mcpServers;
  check(
    'a remote server carries an explicit type',
    servers.agentskills?.type === 'http' && servers.agentskills?.url === 'https://agentskills.io/mcp',
  );
  check('header whitespace is trimmed', servers.agentskills?.headers?.['X-Probe'] === 'spaced');
  check('the per-server timeout is written', servers.agentskills?.timeout === 30000);
  check(
    'a stdio server is written the way `claude mcp add` writes it',
    servers.local_fs?.command === 'npx' && servers.local_fs?.args?.length === 3 && servers.local_fs?.type === 'stdio',
  );
  check('a disabled server is not written', servers.disabled_one === undefined);
  check('an invalid name is refused', servers['has.dots'] === undefined);
  check('a reserved name is refused', servers.workspace === undefined);
  check('a server added inside the container is left alone', servers['hand-added']?.url === 'https://example.test/mcp');

  snapshot = await ok(page, 'snapshot');
  check(
    'the task remembers which entries it manages',
    taskById(snapshot, alpha.id)?.task.managed.mcpServers.includes('agentskills') === true,
    JSON.stringify(taskById(snapshot, alpha.id)?.task.managed),
  );

  const extSettings = await readContainerJson(page, alpha.id, '/home/claude/.claude/settings.json');
  check(
    'the marketplace is registered',
    extSettings.extraKnownMarketplaces?.['acme-tools']?.source?.repo === 'acme-corp/claude-plugins',
  );
  check(
    'plugins are keyed as plugin@marketplace, both states kept',
    extSettings.enabledPlugins?.['formatter@acme-tools'] === true &&
      extSettings.enabledPlugins?.['experimental@acme-tools'] === false,
  );

  const localSkill = await readContainerFile(page, alpha.id, '/home/claude/.claude/skills/deep-probe/SKILL.md');
  check('the skills CLI installed the named skill', localSkill.includes('DEEP-SKILL-MARKER'));
  check(
    'the apply reports both tasks by name',
    appliedAll.some((line) => line.startsWith(`${TASK_PREFIX}alpha`)) &&
      appliedAll.some((line) => line.startsWith(`${TASK_PREFIX}beta`)),
    JSON.stringify(appliedAll),
  );
  const emptySourceWarned = await page.evaluate(() =>
    window.__ccProvisionLogs.some((line) => line.includes('ソースが空です')),
  );
  check('an entry with no source is reported, not run', emptySourceWarned);
  const handSkill = await readContainerFile(page, alpha.id, '/home/claude/.claude/skills/hand-written/SKILL.md');
  check('a hand-written skill is left alone', handSkill.includes('hand made'));

  const statuses = await ok(page, 'taskMcpStatus', [alpha.id]);
  check('MCP status can be read for a running task', Array.isArray(statuses));

  await ok(page, 'extensionsSave', [{ mcpServers: [], marketplaces: [], plugins: [], skillInstalls: [] }]);
  await ok(page, 'taskProvision', [alpha.id]);
  const afterRemoval = await readContainerJson(page, alpha.id, '/home/claude/.claude.json');
  check('removing a server removes it from the container', afterRemoval.mcpServers?.agentskills === undefined);
  check(
    'the hand-added server still survives',
    afterRemoval.mcpServers?.['hand-added']?.url === 'https://example.test/mcp',
  );
  const settingsAfter = await readContainerJson(page, alpha.id, '/home/claude/.claude/settings.json');
  check('removing a marketplace removes it', settingsAfter.extraKnownMarketplaces?.['acme-tools'] === undefined);
  check('removing a plugin removes it', settingsAfter.enabledPlugins?.['formatter@acme-tools'] === undefined);
  const keptSkill = await sh(page, alpha.id, 'test -e ~/.claude/skills/deep-probe/SKILL.md && echo yes || echo no');
  check('dropping an entry leaves the installed skill in the container', keptSkill.stdout.trim() === 'yes');

  console.log('\n[F] terminals');

  const shellA = await ok(page, 'termOpen', [{ taskId: alpha.id, kind: 'shell', cols: 80, rows: 24 }]);
  const shellB = await ok(page, 'termOpen', [{ taskId: alpha.id, kind: 'shell', cols: 100, rows: 30 }]);
  check('two shells get distinct ids', shellA.id !== shellB.id);
  check('resize accepted', (await call(page, 'termResize', [shellA.id, 132, 43])).ok === true);
  check(
    'a zero-size resize is ignored rather than throwing',
    (await call(page, 'termResize', [shellA.id, 0, 0])).ok === true,
  );
  check(
    'resizing an unknown terminal is a no-op',
    (await call(page, 'termResize', ['no-such-terminal', 80, 24])).ok === true,
  );
  check(
    'writing to an unknown terminal is a no-op',
    (await call(page, 'termWrite', ['no-such-terminal', 'x'])).ok === true,
  );
  check('closing an unknown terminal is a no-op', (await call(page, 'termClose', ['no-such-terminal'])).ok === true);
  await ok(page, 'termClose', [shellA.id]);
  await ok(page, 'termClose', [shellB.id]);

  const wide = await ok(page, 'termOpen', [{ taskId: alpha.id, kind: 'shell', cols: 200, rows: 50 }]);
  await page.evaluate((id) => {
    window.__ccTermText = '';
    window.cc.onTerminalData((event) => {
      if (event.id === id) window.__ccTermText += event.data;
    });
  }, wide.id);
  await page.waitForTimeout(600);
  const REPEATS = 20000;
  await ok(page, 'termWrite', [wide.id, `printf 'あ%.0s' $(seq 1 ${REPEATS}); printf '\\nDONE-CJK\\n'\n`]);
  const termText = await waitFor(
    page,
    () => page.evaluate(() => window.__ccTermText ?? ''),
    (text) => (text.match(/DONE-CJK/gu) ?? []).length >= 2,
    60000,
  );
  check('a 60KB run of 3-byte characters survives the pty stream intact', !termText.includes('�'));
  check(
    'and every character arrived',
    (termText.match(/あ/gu) ?? []).length >= REPEATS,
    `${(termText.match(/あ/gu) ?? []).length}/${REPEATS}`,
  );
  await ok(page, 'termClose', [wide.id]);

  const claudeTab = await ok(page, 'termOpen', [{ taskId: alpha.id, kind: 'claude', cols: 100, rows: 30 }]);
  await page.waitForTimeout(3000);
  let tmux = await sh(page, alpha.id, "tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null");
  check('the Claude Code tab runs inside the cc tmux session', /^cc 1$/mu.test(tmux.stdout), tmux.stdout.trim());
  await ok(page, 'termClose', [claudeTab.id]);
  await page.waitForTimeout(2500);
  tmux = await sh(page, alpha.id, "tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null");
  check('closing the tab leaves the session running and detached', /^cc 0$/mu.test(tmux.stdout), tmux.stdout.trim());
  const leaked = await sh(page, alpha.id, 'tmux list-clients 2>/dev/null | wc -l');
  check('no tmux client is left behind', leaked.stdout.trim() === '0');
  const betaTmux = await sh(page, beta.id, 'tmux list-sessions 2>/dev/null | wc -l');
  check('the other task has no tmux session of its own', betaTmux.stdout.trim() === '0');

  console.log('\n[G] lifecycle and persistence');

  const openDuringStop = await ok(page, 'termOpen', [{ taskId: alpha.id, kind: 'shell', cols: 80, rows: 24 }]);
  await page.waitForTimeout(800);
  await ok(page, 'taskStop', [alpha.id]);
  snapshot = await ok(page, 'snapshot');
  check('stop reports not running', taskById(snapshot, alpha.id)?.container.running === false);
  const resets = await page.evaluate(() => window.__ccResets);
  check('stopping a task resets its terminals in the renderer', resets.includes(alpha.id), JSON.stringify(resets));
  check(
    'and a handle from before the stop is harmless',
    (await call(page, 'termResize', [openDuringStop.id, 90, 30])).ok === true,
  );
  const execStopped = await call(page, 'taskExec', [alpha.id, { command: ['true'], asRoot: false }]);
  check(
    'exec on a stopped task fails with a readable message',
    execStopped.ok === false && /起動していません|not running/u.test(execStopped.error),
  );
  check('stopping an already stopped task is a no-op', (await call(page, 'taskStop', [alpha.id])).ok === true);
  check('the other task kept running', taskById(snapshot, beta.id)?.container.running === true);

  await ok(page, 'taskStart', [alpha.id]);
  check('restart brings it back', taskById(await ok(page, 'snapshot'), alpha.id)?.container.running === true);
  check(
    'the workspace survived the restart',
    (await readContainerFile(page, alpha.id, '/home/claude/workspace/only-in-alpha.txt')) === 'alpha\n',
  );
  check('starting an already running task is a no-op', (await call(page, 'taskStart', [alpha.id])).ok === true);

  console.log('\n[H] export guards the delete');

  const exportRoot = join(scratch, 'exports');
  mkdirSync(exportRoot, { recursive: true });
  await mockDirectoryDialog(exportRoot);
  await sh(page, alpha.id, 'ln -sfn /etc/hostname ~/workspace/escape-link');
  const refused = await call(page, 'taskDelete', [alpha.id, { exportFirst: true }]);
  check(
    'a delete whose export skipped something is refused',
    refused.ok === false && /取り出せなかった|could not be exported/u.test(refused.error),
    refused.ok ? 'deleted!' : refused.error,
  );
  snapshot = await ok(page, 'snapshot');
  check('the task is still there', taskById(snapshot, alpha.id) !== null);
  check('and still running', taskById(snapshot, alpha.id)?.container.running === true);
  const partialPath = refused.ok ? '' : (/the partial export is at (.+)$/u.exec(refused.error)?.[1] ?? '');
  check(
    'the partial export was kept on disk and named in the message',
    partialPath !== '' && existsSync(join(partialPath, 'only-in-alpha.txt')),
    partialPath,
  );
  const exportWarned = await page.evaluate(() => window.__ccAppLogs.some((line) => line.includes('escape-link')));
  check('the skipped entry is named in the log', exportWarned);

  await sh(page, alpha.id, 'rm -f ~/workspace/escape-link');
  const cleanExport = await ok(page, 'taskExport', [alpha.id]);
  check('export succeeds once the link is gone', cleanExport !== null && cleanExport.skipped.length === 0);
  check(
    'the export holds the workspace file',
    cleanExport !== null && existsSync(join(cleanExport.path, 'only-in-alpha.txt')),
  );
  check('no .partial directory left behind', cleanExport !== null && !existsSync(`${cleanExport.path}.partial`));

  await mockDirectoryDialog(null);
  const cancelled = await call(page, 'taskDelete', [alpha.id, { exportFirst: true }]);
  check(
    'a delete that cannot export refuses instead of destroying',
    cancelled.ok === false,
    cancelled.ok ? 'deleted!' : cancelled.error,
  );
  check('the task survived the cancelled export', taskById(await ok(page, 'snapshot'), alpha.id) !== null);
  const cancelledExport = await ok(page, 'taskExport', [alpha.id]);
  check('a cancelled export dialog returns null', cancelledExport === null);
  await mockDirectoryDialog(exportRoot);

  console.log('\n[I] a same-name container the app did not create');

  await writeContainerFile(page, beta.id, '/home/claude/workspace/beta-marker.txt', 'beta\n');
  await ok(page, 'taskStop', [beta.id]);
  execFileSync('docker', ['rm', '-f', beta.containerName], { stdio: 'ignore' });
  execFileSync('docker', ['create', '--name', beta.containerName, boot.config.imageTag], { stdio: 'ignore' });
  try {
    const adopted = await call(page, 'taskStart', [beta.id]);
    check(
      'a same-name container without our labels is refused, not adopted',
      adopted.ok === false && adopted.error.includes(beta.containerName),
      JSON.stringify(adopted),
    );
    const execForeign = await call(page, 'taskExec', [beta.id, { command: ['true'], asRoot: false }]);
    check('exec into the foreign container is refused too', execForeign.ok === false);
    const termForeign = await call(page, 'termOpen', [{ taskId: beta.id, kind: 'shell', cols: 80, rows: 24 }]);
    check('a terminal into the foreign container is refused too', termForeign.ok === false);
    const deleteForeign = await call(page, 'taskDelete', [beta.id, { exportFirst: false }]);
    check('deleting the task does not remove the foreign container', deleteForeign.ok === false);
    check('the foreign container is untouched', dockerContainerExists(beta.containerName));
  } finally {
    execFileSync('docker', ['rm', '-f', beta.containerName], { stdio: 'ignore' });
  }
  await ok(page, 'taskStart', [beta.id]);
  check(
    'once the impostor is gone the task starts again on its own volume',
    (await readContainerFile(page, beta.id, '/home/claude/workspace/beta-marker.txt')) === 'beta\n',
  );

  console.log('\n[J] an image rebuild is detected per task');

  const realTag = boot.config.imageTag;
  execFileSync('docker', ['build', '-q', '-t', SCRATCH_TAG, '-'], {
    input: `FROM ${realTag}\nRUN echo E2E-LAYER > /tmp/e2e-layer\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  try {
    await ok(page, 'configSave', [{ imageTag: SCRATCH_TAG }]);
    snapshot = await ok(page, 'snapshot');
    check('the scratch image exists', snapshot.image.exists === true && snapshot.image.tag === SCRATCH_TAG);
    check(
      'existing tasks are flagged as running on an older image',
      taskById(snapshot, alpha.id)?.imageStale === true && taskById(snapshot, beta.id)?.imageStale === true,
    );

    await ok(page, 'taskRecreate', [alpha.id]);
    snapshot = await ok(page, 'snapshot');
    const recreated = taskById(snapshot, alpha.id);
    check(
      'recreate moves the task onto the new image',
      recreated?.imageStale === false && recreated?.container.imageId === snapshot.image.id,
      String(recreated?.container.imageId),
    );
    check(
      'recreate keeps the home volume',
      (await readContainerFile(page, alpha.id, '/home/claude/workspace/only-in-alpha.txt')) === 'alpha\n',
    );
    check(
      'the new layer is really there',
      (await sh(page, alpha.id, 'cat /tmp/e2e-layer')).stdout.trim() === 'E2E-LAYER',
    );
    check('the other task is still flagged', taskById(snapshot, beta.id)?.imageStale === true);
    check(
      'the recreated container is provisioned',
      typeof (await readContainerJson(page, alpha.id, '/home/claude/.claude/settings.json')).env?.ANTHROPIC_BASE_URL ===
        'string',
    );
  } finally {
    await ok(page, 'configSave', [{ imageTag: realTag }]);
  }
  snapshot = await ok(page, 'snapshot');
  check('back on the real tag, the untouched task is current again', taskById(snapshot, beta.id)?.imageStale === false);
  check('and the recreated one is now the stale one', taskById(snapshot, alpha.id)?.imageStale === true);
  await ok(page, 'taskRecreate', [alpha.id]);
  check(
    'recreating again lands on the real image',
    taskById(await ok(page, 'snapshot'), alpha.id)?.imageStale === false,
  );

  if (process.env['CC_E2E_SKIP_BUILD'] !== '1') {
    const appBuild = await call(page, 'imageBuild', [{ noCache: false, refreshClaudeCode: false }]);
    check('the app can (re)build the fixed base image', appBuild.ok === true, appBuild.error ?? '');
    const buildLogs = await page.evaluate(() => window.__ccBuildLogs ?? []);
    check('build progress was streamed to the log pane', buildLogs.length > 1, `${buildLogs.length} lines`);
    check(
      'the image is still current for the recreated task',
      taskById(await ok(page, 'snapshot'), alpha.id)?.imageStale === false,
    );
  }

  console.log('\n[J2] environments: variables and a setup script, once per container');

  const envLabels = dockerLabelsOf(alpha.containerName);
  check(
    'a task created on the default environment carries its label',
    envLabels['com.cc-container-desktop.environment'] === defaultEnvironmentId &&
      typeof envLabels['com.cc-container-desktop.environment-revision'] === 'string',
    JSON.stringify(envLabels),
  );
  check('and is not flagged as stale', taskById(snapshot, alpha.id)?.environmentStale === false);

  const envText = 'CC_E2E_MARKER=deep\r\nCC_E2E_MULTI="line one\nline two"\n# a comment\nCC_E2E_QUOTED=\'single\'';
  const setupScript = [
    '#!/bin/bash',
    'set -e',
    'echo "setup ran with $CC_E2E_MARKER"',
    'echo "$CC_E2E_MARKER" >> ~/workspace/setup-ran.txt',
    'test "$(pwd)" = /home/claude/workspace',
    'test "$(id -un)" = claude',
    'node --version > ~/workspace/setup-node.txt',
    '',
  ].join('\n');
  const savedEnv = await ok(page, 'environmentUpsert', [{ id: 'e2e-env', name: '  E2E   env ', envText, setupScript }]);
  const e2eEnv = savedEnv.environments.find((environment) => environment.id === 'e2e-env');
  check('the environment is saved with a normalized name', e2eEnv?.name === 'E2E env', JSON.stringify(e2eEnv?.name));
  check('CRLF is normalized on save', e2eEnv !== undefined && !e2eEnv.envText.includes('\r'));
  check('the seeded environment stays the default', savedEnv.defaultEnvironmentId === defaultEnvironmentId);

  const gamma = (await session.createTask({ name: `${TASK_PREFIX}gamma`, environmentId: 'e2e-env' })).task;
  check('the task records its environment', gamma.environmentId === 'e2e-env');
  const gammaEnv = await sh(page, gamma.id, 'printf "%s|%s|%s" "$CC_E2E_MARKER" "$CC_E2E_QUOTED" "$CC_E2E_MULTI"');
  check(
    'the variables are in the container environment, multi-line value included',
    gammaEnv.stdout === 'deep|single|line one\nline two',
    JSON.stringify(gammaEnv.stdout),
  );
  const gammaLabels = dockerLabelsOf(gamma.containerName);
  check(
    'the container is labelled with the environment and its revision',
    gammaLabels['com.cc-container-desktop.environment'] === 'e2e-env' &&
      gammaLabels['com.cc-container-desktop.environment-revision'] !==
        envLabels['com.cc-container-desktop.environment-revision'],
  );
  const ranOnce = await readContainerFile(page, gamma.id, '/home/claude/workspace/setup-ran.txt');
  check(
    'the setup script ran once, in the workspace, with the variables',
    ranOnce === 'deep\n',
    JSON.stringify(ranOnce),
  );
  check(
    'the setup script runs with the image tools on PATH',
    (await readContainerFile(page, gamma.id, '/home/claude/workspace/setup-node.txt')).startsWith('v'),
  );
  check(
    'the done-marker was written',
    (await sh(page, gamma.id, 'test -e /opt/cc/.setup-done && echo yes || echo no')).stdout.trim() === 'yes',
  );
  const setupStreamed = await page.evaluate(() =>
    window.__ccSetupLogs.some((line) => line.includes('setup ran with deep')),
  );
  check('setup output streams to the log pane', setupStreamed);

  await ok(page, 'taskStop', [gamma.id]);
  await ok(page, 'taskStart', [gamma.id]);
  check(
    'stop/start does not rerun the setup script',
    (await readContainerFile(page, gamma.id, '/home/claude/workspace/setup-ran.txt')) === 'deep\n',
  );

  await ok(page, 'environmentUpsert', [
    { id: 'e2e-env', name: 'E2E env', envText: 'CC_E2E_MARKER=edited', setupScript },
  ]);
  snapshot = await ok(page, 'snapshot');
  check('editing the environment flags the task that uses it', taskById(snapshot, gamma.id)?.environmentStale === true);
  check('a task on another environment is unaffected', taskById(snapshot, alpha.id)?.environmentStale === false);
  await ok(page, 'taskRecreate', [gamma.id]);
  snapshot = await ok(page, 'snapshot');
  check('recreate applies the edited environment', taskById(snapshot, gamma.id)?.environmentStale === false);
  check(
    'the new value is in the container',
    (await sh(page, gamma.id, 'printf %s "$CC_E2E_MARKER"')).stdout === 'edited',
  );
  check(
    'recreate reruns the setup script and keeps the workspace',
    (await readContainerFile(page, gamma.id, '/home/claude/workspace/setup-ran.txt')) === 'deep\nedited\n',
  );
  await ok(page, 'environmentUpsert', [
    { id: 'e2e-env', name: 'E2E env', envText: '# only a comment was added\nCC_E2E_MARKER=edited', setupScript },
  ]);
  check(
    'a comment-only edit does not flag the task',
    taskById(await ok(page, 'snapshot'), gamma.id)?.environmentStale === false,
  );

  const switchedEnv = await ok(page, 'taskUpdate', [gamma.id, { environmentId: defaultEnvironmentId }]);
  check('taskUpdate switches the environment', switchedEnv.environmentId === defaultEnvironmentId);
  check(
    'a switched task is flagged until it is recreated',
    taskById(await ok(page, 'snapshot'), gamma.id)?.environmentStale === true,
  );
  await ok(page, 'taskUpdate', [gamma.id, { environmentId: 'e2e-env' }]);
  check('switching back clears the flag', taskById(await ok(page, 'snapshot'), gamma.id)?.environmentStale === false);

  await ok(page, 'environmentArchive', ['e2e-env', true]);
  const onArchived = await call(page, 'taskCreate', [
    { name: 'x', note: '', profileId: null, environmentId: 'e2e-env', source: { kind: 'empty' } },
  ]);
  check('an archived environment cannot be picked for a new task', onArchived.ok === false, onArchived.error ?? '');
  const switchToArchived = await call(page, 'taskUpdate', [alpha.id, { environmentId: 'e2e-env' }]);
  check('nor switched to', switchToArchived.ok === false);
  check(
    'the task that already has it keeps it',
    taskById(await ok(page, 'snapshot'), gamma.id)?.task.environmentId === 'e2e-env',
  );
  const deleteInUse = await call(page, 'environmentDelete', ['e2e-env']);
  check('an environment a task uses cannot be deleted', deleteInUse.ok === false, deleteInUse.error ?? '');
  await ok(page, 'environmentArchive', [defaultEnvironmentId, true]);
  check(
    'archiving the last active environment leaves no default',
    (await ok(page, 'snapshot')).config.defaultEnvironmentId === null,
  );
  await ok(page, 'environmentArchive', [defaultEnvironmentId, false]);
  check(
    'restoring it makes it the default again',
    (await ok(page, 'snapshot')).config.defaultEnvironmentId === defaultEnvironmentId,
  );

  await ok(page, 'environmentUpsert', [
    {
      id: 'e2e-broken',
      name: 'broken setup',
      envText: '',
      setupScript: 'echo attempt >> ~/workspace/attempts.txt\nexit 3\n',
    },
  ]);
  const delta = await session.createTask({ name: `${TASK_PREFIX}delta`, environmentId: 'e2e-broken' });
  check(
    'a failing setup script does not fail task creation, but warns',
    delta.warning !== null && /exit 3/u.test(delta.warning),
    delta.warning ?? 'no warning',
  );
  check(
    'no done-marker after a failure',
    (await sh(page, delta.task.id, 'test -e /opt/cc/.setup-done && echo yes || echo no')).stdout.trim() === 'no',
  );
  await ok(page, 'taskStop', [delta.task.id]);
  await ok(page, 'taskStart', [delta.task.id]);
  check(
    'the next start retries the setup script',
    (await readContainerFile(page, delta.task.id, '/home/claude/workspace/attempts.txt')) === 'attempt\nattempt\n',
  );
  await ok(page, 'taskDelete', [delta.task.id, { exportFirst: false }]);
  session.forgetTask(delta.task.id);
  await ok(page, 'environmentArchive', ['e2e-broken', true]);
  await ok(page, 'environmentDelete', ['e2e-broken']);

  await ok(page, 'taskDelete', [gamma.id, { exportFirst: false }]);
  session.forgetTask(gamma.id);
  const deletedEnv = await ok(page, 'environmentDelete', ['e2e-env']);
  check(
    'an unused archived environment can be deleted',
    !deletedEnv.environments.some((environment) => environment.id === 'e2e-env'),
  );

  console.log('\n[K] importing host files');

  const inbox = join(scratch, 'inbox');
  mkdirSync(join(inbox, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(inbox, 'nested', 'deeper', 'leaf.txt'), 'leaf\n');
  writeFileSync(join(inbox, '日本語 と スペース.txt'), 'cjk\n');
  writeFileSync(join(scratch, 'single.txt'), 'single\n');
  const imported = await ok(page, 'taskImport', [alpha.id, [inbox, join(scratch, 'single.txt')]]);
  check(
    'import counts what it copied',
    imported.entries >= 4 && imported.sources.length === 2,
    JSON.stringify(imported),
  );
  const found = await sh(page, alpha.id, 'cd ~/workspace && find . -type f | sort');
  check('nested folders arrive intact', found.stdout.includes('./inbox/nested/deeper/leaf.txt'), found.stdout.trim());
  check('CJK file names survive the import', found.stdout.includes('./inbox/日本語 と スペース.txt'));
  check('a single file lands at the workspace root', found.stdout.includes('./single.txt'));
  check(
    'imported files are owned by claude',
    (await sh(page, alpha.id, 'stat -c %U:%G ~/workspace/single.txt ~/workspace/inbox/nested/deeper/leaf.txt')).stdout
      .split('\n')
      .filter(Boolean)
      .every((line) => line === 'claude:claude'),
  );
  const missingImport = await call(page, 'taskImport', [alpha.id, [join(scratch, 'does-not-exist')]]);
  check('importing a missing path is an error', missingImport.ok === false);
  const emptyDir = join(scratch, 'empty-dir');
  mkdirSync(emptyDir, { recursive: true });
  await ok(page, 'taskImport', [alpha.id, [emptyDir]]);
  check(
    'an empty folder still shows up',
    (await sh(page, alpha.id, 'test -d ~/workspace/empty-dir && echo yes || echo no')).stdout.trim() === 'yes',
  );

  console.log('\n[L] the UI follows the tasks');

  await selectTask(page, alpha.id);
  const headerName = await page.evaluate(() => document.querySelector('.task-name-input')?.value ?? '');
  check('the task header shows the selected task', headerName === `${TASK_PREFIX}alpha`, headerName);
  await page.click('[data-testid="open-shell"]');
  await page.waitForTimeout(2500);
  const tabCount = await page.evaluate(() => document.querySelectorAll('.term-tabs .tab').length);
  check('opening a shell from the header adds a tab', tabCount === 1, String(tabCount));
  await selectTask(page, beta.id);
  const betaTabs = await page.evaluate(() => document.querySelectorAll('.term-tabs .tab').length);
  check('tabs belong to their task', betaTabs === 0, String(betaTabs));
  await selectTask(page, alpha.id);
  check(
    'switching back shows the tab again',
    (await page.evaluate(() => document.querySelectorAll('.term-tabs .tab').length)) === 1,
  );
  await shoot(page, 'deep-task');
  await page.click('[data-testid="task-stop"]');
  const tabsAfterStop = await waitFor(
    page,
    () => page.evaluate(() => document.querySelectorAll('.term-tabs .tab').length),
    (count) => count === 0,
    20000,
  );
  check('stopping from the header drops the tabs', tabsAfterStop === 0, String(tabsAfterStop));
  await waitFor(
    page,
    () => page.evaluate(() => document.querySelector('[data-testid="task-start"]') !== null),
    (present) => present === true,
    20000,
  );
  await page.click('[data-testid="task-start"]');
  const runningAgain = await waitFor(
    page,
    async () => taskById(await ok(page, 'snapshot'), alpha.id)?.container.running === true,
    (running) => running === true,
    90000,
  );
  check('starting from the header brings it back', runningAgain === true);

  await goView(page, 'environments');
  const toolRows = await page.evaluate(
    () => document.querySelectorAll('[data-testid="base-image-tools"] tbody tr').length,
  );
  check('the environments page lists the base image tools', toolRows === 11, String(toolRows));
  await page.click('[data-testid="env-new"]');
  await page.waitForSelector('[data-testid="environment-dialog"]');
  const dialogTitle = await page.evaluate(() => document.querySelector('#env-modal-title')?.textContent ?? '');
  check('the create dialog opens', dialogTitle === '環境を作成', dialogTitle);
  await page.fill('#env-dialog-name', 'UI env');
  await page.fill('#env-dialog-vars', 'UI_MARKER=1');
  await page.fill('#env-dialog-setup', 'echo ui');
  await page.click('[data-testid="environment-save"]');
  await page.waitForSelector('[data-testid="environment-dialog"]', { state: 'detached' });
  snapshot = await ok(page, 'snapshot');
  const uiEnv = snapshot.config.environments.find((environment) => environment.name === 'UI env');
  check(
    'the dialog created the environment',
    uiEnv !== undefined && uiEnv.envText === 'UI_MARKER=1' && uiEnv.setupScript === 'echo ui',
    JSON.stringify(uiEnv),
  );
  await page.click(`.env-row[data-environment-id="${uiEnv.id}"] [data-testid="env-edit"]`);
  await page.waitForSelector('[data-testid="environment-dialog"]');
  const editTitle = await page.evaluate(() => document.querySelector('#env-modal-title')?.textContent ?? '');
  check('the edit dialog opens with the reference title', editTitle === '環境を編集', editTitle);
  await shoot(page, 'deep-environment-dialog');
  await page.fill('#env-dialog-vars', 'UI_MARKER=1\nBROKEN LINE');
  await page.waitForTimeout(200);
  const saveBlocked = await page.evaluate(() => document.querySelector('[data-testid="environment-save"]').disabled);
  check('an invalid variables box blocks saving', saveBlocked === true);
  await page.click('[data-testid="environment-archive"]');
  await page.waitForSelector('[data-testid="environment-dialog"]', { state: 'detached' });
  check(
    'archive from the dialog archives it',
    (await ok(page, 'snapshot')).config.environments.find((environment) => environment.id === uiEnv.id)?.archived ===
      true,
  );
  await ok(page, 'environmentDelete', [uiEnv.id]);
  await shoot(page, 'deep-environments');

  await ok(page, 'setLanguage', ['en']);
  await page.waitForTimeout(700);
  const englishNav = await page.evaluate(
    () => document.querySelector('.sidebar-nav button')?.textContent?.trim() ?? '',
  );
  check('UI switched to English', englishNav.includes('Profiles'), englishNav);
  await ok(page, 'setLanguage', ['ja']);
  await page.waitForTimeout(700);
  const japaneseNav = await page.evaluate(
    () => document.querySelector('.sidebar-nav button')?.textContent?.trim() ?? '',
  );
  check('UI switched back to Japanese', japaneseNav.includes('プロファイル'), japaneseNav);

  console.log('\n[M] profiles and tasks part ways cleanly');

  await ok(page, 'taskUpdate', [beta.id, { profileId: keyed.id }]);
  await ok(page, 'profileDelete', [keyed.id]);
  snapshot = await ok(page, 'snapshot');
  check('deleting a profile drops its secret', (await ok(page, 'secretGet', [keyed.id])) === '');
  check(
    'a task that used the deleted profile falls back to none',
    taskById(snapshot, beta.id)?.task.profileId === null,
  );
  check(
    'the default profile falls back to a surviving one',
    snapshot.config.defaultProfileId !== keyed.id &&
      snapshot.config.profiles.some((p) => p.id === snapshot.config.defaultProfileId),
  );
  await ok(page, 'taskProvision', [beta.id]);
  const betaNoProfile = await readContainerJson(page, beta.id, '/home/claude/.claude/settings.json');
  check('a task without a profile gets no env block', betaNoProfile.env === undefined);

  console.log('\n[N] delete removes exactly this task');

  const alphaDelete = await ok(page, 'taskDelete', [alpha.id, { exportFirst: false }]);
  session.forgetTask(alpha.id);
  check('delete without export reports no export', alphaDelete.exportedTo === null);
  check('the container is gone', !dockerContainerExists(alpha.containerName));
  check('the volume is gone', !dockerVolumeExists(alpha.volumeName));
  check(
    'the other task and its volume are untouched',
    dockerContainerExists(beta.containerName) && dockerVolumeExists(beta.volumeName),
  );
  snapshot = await ok(page, 'snapshot');
  check('the task list only holds the survivor', snapshot.tasks.length === 1 && snapshot.tasks[0].task.id === beta.id);
  const deleteAgain = await call(page, 'taskDelete', [alpha.id, { exportFirst: false }]);
  check('deleting a deleted task is an error, not a crash', deleteAgain.ok === false);
} catch (error) {
  harnessFailure(error);
} finally {
  await session.close();
  rmSync(scratch, { recursive: true, force: true });
  try {
    execFileSync('docker', ['rmi', '-f', SCRATCH_TAG], { stdio: 'ignore' });
  } catch {}
}

finish();
