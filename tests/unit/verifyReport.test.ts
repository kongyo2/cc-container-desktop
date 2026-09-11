import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseImageInfo, parseVerifyOutput } from '../../src/main/images/verifyReport.ts';

test('verify-runtime.sh output is parsed into passed and failed checks', () => {
  const report = parseVerifyOutput(
    ['ok user.uid', 'ok node.version v24.21.0', 'fail tool.tmux: tmux is not on PATH', 'RESULT 2 1', ''].join('\n'),
  );
  assert.deepEqual(report.passed, ['user.uid', 'node.version v24.21.0']);
  assert.deepEqual(report.failed, ['tool.tmux: tmux is not on PATH']);
  assert.equal(report.complete, true);
});

test('a truncated report is not complete', () => {
  const report = parseVerifyOutput('ok user.uid\nok user.gid\n');
  assert.equal(report.complete, false);
  assert.equal(report.failed.length, 0);
});

test('image-info.json is parsed with its tool versions and rejected when malformed', () => {
  const info = parseImageInfo(
    JSON.stringify({
      schemaVersion: 1,
      project: 'cc-container-desktop',
      variant: 'web',
      release: '2026.09.1',
      runtimeContract: 1,
      sourceRevision: 'abc1234',
      tools: { node: '24.21.0', pnpm: '12.3.4', broken: 5 },
    }),
  );
  assert.ok(info);
  assert.equal(info.variant, 'web');
  assert.equal(info.runtimeContract, 1);
  assert.equal(info.sourceRevision, 'abc1234');
  assert.deepEqual(info.tools, { node: '24.21.0', pnpm: '12.3.4' });
  assert.equal(parseImageInfo('{ not json'), null);
  assert.equal(parseImageInfo(JSON.stringify({ release: '1' })), null);
  assert.equal(parseImageInfo(JSON.stringify({ variant: 'web', release: '1' }))?.runtimeContract, -1);
});
