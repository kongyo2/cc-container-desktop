import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateSnapshot,
  applyPullEvent,
  completePullAggregate,
  createPullAggregate,
  parsePullLine,
  PullStreamParser,
} from '../../src/main/docker/pullStream.ts';

const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

test('events are parsed with typed fields and errors are surfaced', () => {
  const event = parsePullLine(line({ status: 'Downloading', id: 'abc', progressDetail: { current: 5, total: 10 } }));
  assert.deepEqual(event, { status: 'Downloading', id: 'abc', current: 5, total: 10, error: null });
  assert.equal(parsePullLine('not json'), null);
  assert.equal(parsePullLine('[1,2]'), null);
  assert.deepEqual(parsePullLine(line({ error: 'boom', errorDetail: { message: 'detailed boom' } })), {
    status: null,
    id: null,
    current: null,
    total: null,
    error: 'detailed boom',
  });
  assert.equal(parsePullLine(line({ progressDetail: { current: -1, total: 'x' }, id: '' }))?.current, null);
});

test('messages split across chunks and several per chunk are reassembled', () => {
  const parser = new PullStreamParser();
  const first = line({ status: 'Pulling from kongyo2/cc-workbench', id: null });
  const second = line({ status: 'Downloading', id: 'l1', progressDetail: { current: 1, total: 4 } });
  const third = line({ status: 'Download complete', id: 'l1' });
  const all = first + second + third;
  const cut = Math.floor(all.length / 3);
  const events = [
    ...parser.push(Buffer.from(all.slice(0, cut))),
    ...parser.push(Buffer.from(all.slice(cut, cut + 7))),
    ...parser.push(Buffer.from(all.slice(cut + 7))),
    ...parser.flush(),
  ];
  assert.equal(events.length, 3);
  assert.equal(events[1]?.current, 1);
  assert.equal(parser.malformed, 0);
});

test('a UTF-8 sequence cut in half survives and a garbage line is skipped, not fatal', () => {
  const parser = new PullStreamParser();
  const text = line({ status: 'ダウンロード中 あいう', id: 'x' }) + 'garbage\n' + line({ status: 'Waiting', id: 'y' });
  const bytes = Buffer.from(text, 'utf8');
  const cut = text.indexOf('あ') + 1;
  const events = [...parser.push(bytes.subarray(0, cut)), ...parser.push(bytes.subarray(cut)), ...parser.flush()];
  assert.equal(events.length, 2);
  assert.equal(events[0]?.status, 'ダウンロード中 あいう');
  assert.equal(parser.malformed, 1);
});

test('a trailing message without a newline is delivered on flush', () => {
  const parser = new PullStreamParser();
  const events = [...parser.push(Buffer.from(JSON.stringify({ status: 'Pull complete', id: 'z' }))), ...parser.flush()];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, 'Pull complete');
});

test('the aggregate counts bytes once per layer, tracks totals and reused layers, and captures the digest', () => {
  const aggregate = createPullAggregate();
  const feed = (value: Record<string, unknown>): void => {
    const event = parsePullLine(line(value));
    assert.ok(event);
    applyPullEvent(aggregate, event);
  };
  feed({ status: 'Pulling from kongyo2/cc-workbench' });
  feed({ status: 'Pulling fs layer', id: 'a' });
  feed({ status: 'Pulling fs layer', id: 'b' });
  feed({ status: 'Already exists', id: 'c' });
  feed({ status: 'Downloading', id: 'a', progressDetail: { current: 10, total: 100 } });
  feed({ status: 'Downloading', id: 'a', progressDetail: { current: 60, total: 100 } });
  feed({ status: 'Downloading', id: 'a', progressDetail: { current: 30, total: 100 } });
  let snapshot = aggregateSnapshot(aggregate);
  assert.equal(snapshot.downloadedBytes, 60, 'a re-sent lower "current" never lowers the count');
  assert.equal(snapshot.totalBytes, null, 'unknown totals leave the sum unknown');
  assert.equal(snapshot.totalLayers, 3);
  assert.equal(snapshot.completedLayers, 1);

  feed({ status: 'Downloading', id: 'b', progressDetail: { current: 5, total: 50 } });
  feed({ status: 'Extracting', id: 'a', progressDetail: { current: 999, total: 999 } });
  snapshot = aggregateSnapshot(aggregate);
  assert.equal(snapshot.downloadedBytes, 65, 'extraction bytes are not added to the download');
  assert.equal(snapshot.totalBytes, 150);

  feed({ status: 'Pull complete', id: 'a' });
  feed({ status: 'Download complete', id: 'b' });
  feed({ status: 'Digest: sha256:' + 'c'.repeat(64) });
  snapshot = aggregateSnapshot(aggregate);
  assert.equal(snapshot.downloadedBytes, 150);
  assert.equal(snapshot.completedLayers, 2);
  assert.equal(aggregate.digest, `sha256:${'c'.repeat(64)}`);
  assert.equal(aggregate.error, null);

  feed({ error: 'unexpected EOF', errorDetail: { message: 'unexpected EOF' } });
  assert.equal(aggregate.error, 'unexpected EOF');
});

test('a containerd-store stream: the reference is not a layer and a clean end completes the config blob', () => {
  const aggregate = createPullAggregate();
  const feed = (value: Record<string, unknown>): void => {
    const event = parsePullLine(line(value));
    assert.ok(event);
    applyPullEvent(aggregate, event);
  };
  feed({ status: 'Pulling from library/hello-world', id: 'latest' });
  feed({ status: 'Pulling fs layer', id: '4f55086f7dd0', progressDetail: {} });
  feed({ status: 'Download complete', id: 'd5e71e642bf5', progressDetail: { hidecounts: true } });
  feed({ status: 'Downloading', id: '4f55086f7dd0', progressDetail: { current: 2415, total: 2415 } });
  feed({ status: 'Download complete', id: '4f55086f7dd0', progressDetail: { hidecounts: true } });
  feed({ status: 'Pull complete', id: '4f55086f7dd0', progressDetail: { hidecounts: true } });
  feed({ status: `Digest: sha256:${'5'.repeat(64)}` });
  feed({ status: 'Status: Downloaded newer image for hello-world:latest' });
  let snapshot = aggregateSnapshot(aggregate);
  assert.equal(snapshot.totalLayers, 2, 'the tag line is not counted as a layer');
  assert.equal(snapshot.completedLayers, 1, 'the config blob has no "Pull complete" of its own');
  assert.equal(aggregate.lastStatus, 'Status: Downloaded newer image for hello-world:latest');
  assert.equal(aggregate.digest, `sha256:${'5'.repeat(64)}`);

  completePullAggregate(aggregate);
  snapshot = aggregateSnapshot(aggregate);
  assert.equal(snapshot.completedLayers, 2);
  assert.equal(snapshot.downloadedBytes, 2415);

  const present = createPullAggregate();
  applyPullEvent(present, {
    status: 'Pulling from cc-e2e/cc-workbench',
    id: `127.0.0.1:5055/cc-e2e/cc-workbench@sha256:${'4'.repeat(64)}`,
    current: null,
    total: null,
    error: null,
  });
  applyPullEvent(present, {
    status: `Status: Image is up to date for x@sha256:${'4'.repeat(64)}`,
    id: null,
    current: null,
    total: null,
    error: null,
  });
  completePullAggregate(present);
  const presentSnapshot = aggregateSnapshot(present);
  assert.equal(presentSnapshot.totalLayers, 0);
  assert.equal(presentSnapshot.completedLayers, 0);
  assert.equal(presentSnapshot.totalBytes, null);
});

test('the layer list is bounded for display', () => {
  const aggregate = createPullAggregate();
  for (let index = 0; index < 100; index += 1) {
    applyPullEvent(aggregate, { status: 'Waiting', id: `layer-${index}`, current: null, total: null, error: null });
  }
  const snapshot = aggregateSnapshot(aggregate, 8);
  assert.equal(snapshot.layers.length, 8);
  assert.equal(snapshot.totalLayers, 100);
});
