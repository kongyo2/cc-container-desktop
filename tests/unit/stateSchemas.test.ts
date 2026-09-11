import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defaultConfig,
  normalizeConfig,
  parseEnvironmentDraft,
  readConfig,
  readSecretsFile,
} from '../../src/main/config/schema.ts';
import { parseNewTaskInput, parseTaskPatch, readTaskFile } from '../../src/main/tasks/schema.ts';
import { AppFailure } from '../../src/main/errors.ts';

const IMAGE_ID = 'img_0123456789abcdef01234567';

test('a fresh config has an instance id, a starter profile and no environments', () => {
  const config = defaultConfig();
  assert.equal(config.schemaVersion, 1);
  assert.match(config.dataInstanceId, /^inst_[0-9a-f]{16}$/u);
  assert.equal(config.profiles.length, 1);
  assert.equal(config.environments.length, 0);
  assert.equal(config.defaultEnvironmentId, null);
  assert.notEqual(defaultConfig().dataInstanceId, config.dataInstanceId);
});

test('the config file is read strictly: no legacy shapes, no unknown keys, dangling defaults re-pointed', () => {
  const config = defaultConfig();
  assert.equal(readConfig(config).ok, true);
  assert.equal(readConfig({ ...config, version: 3 }).ok, false, 'an extra legacy key is rejected');
  assert.equal(readConfig({ ...config, schemaVersion: 2 }).ok, false);
  assert.equal(readConfig({ ...config, imageTag: 'x' }).ok, false);
  const { schemaVersion, ...withoutVersion } = config;
  assert.equal(schemaVersion, 1);
  assert.equal(readConfig(withoutVersion).ok, false);

  const dangling = readConfig({ ...config, defaultProfileId: 'ghost' });
  assert.equal(dangling.ok, true);
  if (dangling.ok) assert.equal(dangling.value.defaultProfileId, config.profiles[0]?.id);
});

test('environments need a registered image id; duplicates are rejected', () => {
  const now = '2026-09-11T00:00:00.000Z';
  const environment = {
    id: 'e1',
    name: 'x',
    imageId: IMAGE_ID,
    envText: '',
    setupScript: '',
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  const config = { ...defaultConfig(), environments: [environment], defaultEnvironmentId: 'e1' };
  assert.equal(readConfig(config).ok, true);
  assert.equal(readConfig({ ...config, environments: [{ ...environment, imageId: 'latest' }] }).ok, false);
  assert.equal(readConfig({ ...config, environments: [environment, environment] }).ok, false);
  const archivedDefault = normalizeConfig({ ...config, environments: [{ ...environment, archived: true }] });
  assert.equal(archivedDefault.defaultEnvironmentId, null);
});

test('environment drafts are validated and normalized', () => {
  const draft = parseEnvironmentDraft({
    id: 'e',
    name: '  my  env ',
    imageId: IMAGE_ID,
    envText: 'A=1\r\nB=2',
    setupScript: 'echo hi\r\n',
  });
  assert.equal(draft.name, 'my env');
  assert.equal(draft.envText, 'A=1\nB=2');
  assert.equal(draft.setupScript, 'echo hi\n');
  assert.throws(
    () => parseEnvironmentDraft({ id: 'e', name: 'x', imageId: '', envText: '', setupScript: '' }),
    AppFailure,
  );
  assert.throws(
    () => parseEnvironmentDraft({ id: 'e', name: 'x', imageId: IMAGE_ID, envText: 'HOME=/x', setupScript: '' }),
    AppFailure,
  );
  assert.throws(
    () =>
      parseEnvironmentDraft({ id: 'e', name: 'x', imageId: IMAGE_ID, envText: '', setupScript: '', archived: true }),
    AppFailure,
  );
});

test('tasks require an environment and carry the last applied runtime', () => {
  const task = {
    id: 'abcdef',
    name: 't',
    note: '',
    profileId: null,
    environmentId: 'e1',
    source: { kind: 'empty' },
    containerName: 'cc-task-abcdef',
    volumeName: 'cc-task-abcdef-home',
    createdAt: '2026-09-11T00:00:00.000Z',
    managed: { mcpServers: [], marketplaces: [], plugins: [] },
    lastAppliedRuntime: {
      registeredImageId: IMAGE_ID,
      localImageId: 'sha256:x',
      engineId: 'e',
      environmentId: 'e1',
      environmentRevision: 'r',
      appliedAt: '2026-09-11T00:00:00.000Z',
    },
  };
  assert.equal(readTaskFile({ schemaVersion: 1, tasks: [task] }).ok, true);
  assert.equal(readTaskFile({ version: 1, tasks: [task] }).ok, false);
  assert.equal(readTaskFile({ schemaVersion: 1, tasks: [{ ...task, environmentId: null }] }).ok, false);
  assert.equal(readTaskFile({ schemaVersion: 1, tasks: [task, task] }).ok, false);

  assert.throws(
    () => parseNewTaskInput({ name: 'x', note: '', profileId: null, source: { kind: 'empty' } }),
    AppFailure,
  );
  const patch = parseTaskPatch({ name: 'renamed', environmentId: undefined });
  assert.deepEqual(patch, { name: 'renamed' });
  assert.throws(() => parseTaskPatch({ environmentId: '' }), AppFailure);
});

test('the secrets file only accepts the current shape', () => {
  assert.equal(readSecretsFile({ schemaVersion: 1, entries: { p: { enc: 'plain', value: 'k' } } }).ok, true);
  assert.equal(readSecretsFile({ version: 2, entries: {} }).ok, false);
  assert.equal(readSecretsFile({ schemaVersion: 1, entries: { p: 'k' } }).ok, false);
});
