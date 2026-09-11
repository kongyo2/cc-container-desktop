import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppFailure, classifyDockerError, isNotFound, toAppError } from '../../src/main/errors.ts';

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function errnoError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

test('Docker errors are classified by status, errno and message', () => {
  assert.equal(
    classifyDockerError(errnoError('ENOENT', 'connect ENOENT //./pipe/docker_engine'), 'connect').code,
    'DOCKER_UNAVAILABLE',
  );
  assert.equal(
    classifyDockerError(errnoError('ECONNREFUSED', 'connect ECONNREFUSED'), 'pull').code,
    'DOCKER_UNAVAILABLE',
  );
  assert.equal(classifyDockerError(httpError(404, 'manifest unknown'), 'pull').code, 'IMAGE_NOT_FOUND');
  assert.equal(classifyDockerError(httpError(401, 'unauthorized'), 'pull').code, 'REGISTRY_AUTH_REQUIRED');
  assert.equal(
    classifyDockerError(new Error('pull access denied for x, repository does not exist'), 'pull').code,
    'REGISTRY_AUTH_REQUIRED',
  );
  assert.equal(
    classifyDockerError(httpError(429, 'toomanyrequests: You have reached your pull rate limit'), 'pull').code,
    'RATE_LIMITED',
  );
  assert.equal(
    classifyDockerError(new Error('write /var/lib/docker/tmp: no space left on device'), 'pull').code,
    'NO_SPACE',
  );
  assert.equal(
    classifyDockerError(new Error('no matching manifest for linux/arm64 in the manifest list entries'), 'pull').code,
    'UNSUPPORTED_PLATFORM',
  );
  assert.equal(
    classifyDockerError(
      new Error('Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: EAI_AGAIN'),
      'pull',
    ).code,
    'NETWORK_ERROR',
  );
  assert.equal(classifyDockerError(new Error('something else entirely'), 'create').code, 'DOCKER_ERROR');
});

test('classification keeps AppFailures and marks what is worth retrying', () => {
  const original = new AppFailure('CANCELLED', 'stop');
  assert.equal(classifyDockerError(original, 'pull'), original);
  assert.equal(classifyDockerError(errnoError('ECONNRESET', 'read ECONNRESET'), 'pull').retryable, true);
  assert.equal(classifyDockerError(httpError(429, 'toomanyrequests'), 'pull').retryable, false);
  assert.equal(classifyDockerError(new Error('no space left on device'), 'pull').retryable, false);
});

test('errors become structured results', () => {
  assert.deepEqual(toAppError(new AppFailure('IMAGE_IN_USE', 'used', { retryable: false })), {
    code: 'IMAGE_IN_USE',
    message: 'used',
    retryable: false,
  });
  assert.deepEqual(toAppError(new Error('plain')), { code: 'APP_ERROR', message: 'plain', retryable: false });
  assert.deepEqual(toAppError('text'), { code: 'APP_ERROR', message: 'text', retryable: false });
  assert.equal(isNotFound(httpError(404, 'x')), true);
  assert.equal(isNotFound(new Error('x')), false);
});
