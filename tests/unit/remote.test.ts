import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameDecoder, FrameError, encodeFrame } from '../../src/main/remote/frame.ts';
import { ProtocolError, parseRemoteMessage } from '../../src/main/remote/protocol.ts';
import {
  DEFAULT_REMOTE_PORT,
  PAIRING_CODE_LENGTH,
  decodeRemoteTicket,
  encodeRemoteTicket,
  formatFingerprint,
  formatPairingCode,
  formatRemoteAddress,
  normalizePairingCode,
  normalizeRemoteName,
  parseRemoteAddress,
} from '../../src/shared/remote.ts';
import type { RemoteTicket } from '../../src/shared/remote.ts';

const FINGERPRINT = 'a'.repeat(64);

function ticket(overrides: Partial<RemoteTicket> = {}): RemoteTicket {
  return {
    instanceId: 'rid_0123456789abcdef',
    name: '作業机 / desk',
    fingerprint: FINGERPRINT,
    port: DEFAULT_REMOTE_PORT,
    addresses: ['192.168.1.20:47713', '[fd00::1]:47713'],
    code: '23456789AB',
    ...overrides,
  };
}

test('frames survive being split and glued back together at any byte boundary', () => {
  const messages = [{ t: 'ping', at: 1 }, { t: 'event', channel: 'evt:log', payload: { text: 'ようこそ' } }, 42];
  const wire = Buffer.concat(messages.map((message) => encodeFrame(message)));

  const decoder = new FrameDecoder();
  const seen: unknown[] = [];
  for (let index = 0; index < wire.length; index += 1) {
    seen.push(...decoder.push(wire.subarray(index, index + 1)));
  }
  assert.deepEqual(seen, messages);
  assert.equal(decoder.pending, 0);

  const atOnce = new FrameDecoder();
  assert.deepEqual(atOnce.push(wire), messages);
});

test('a frame decoder refuses an absurd length instead of allocating for it', () => {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(4_000_000_000, 0);
  assert.throws(() => new FrameDecoder().push(header), FrameError);
  const broken = Buffer.allocUnsafe(5);
  broken.writeUInt32BE(1, 0);
  broken.write('{', 4, 'utf8');
  assert.throws(() => new FrameDecoder().push(broken), { name: 'FrameError' });
});

test('every message kind round-trips, and anything else is rejected', () => {
  const samples = [
    {
      t: 'hello',
      protocol: 1,
      instanceId: 'rid_1',
      name: 'x',
      appVersion: '1',
      platform: 'linux',
      nonce: 'n',
      pairing: true,
    },
    { t: 'auth', clientId: 'c', clientName: 'n', token: 'tok' },
    { t: 'pair', clientId: 'c', clientName: 'n', nonce: 'n', proof: 'p' },
    { t: 'welcome', sessionId: 's', instanceId: 'rid_1', name: 'x', appVersion: '1', platform: 'linux' },
    { t: 'call', id: '1', channel: 'app:snapshot', args: [1, 'two', null] },
    { t: 'reply', id: '1', result: { ok: true, value: { deep: [1, 2] } } },
    { t: 'event', channel: 'evt:state', payload: null },
    { t: 'chunk', id: 't', seq: 3, data: 'AAAA' },
    { t: 'streamEnd', id: 't', error: null },
    { t: 'streamAck', id: 't', seq: 3 },
  ];
  for (const sample of samples) {
    assert.deepEqual(parseRemoteMessage(JSON.parse(JSON.stringify(sample))), sample);
  }

  assert.throws(() => parseRemoteMessage({ t: 'nope' }), ProtocolError);
  assert.throws(() => parseRemoteMessage('hello'), ProtocolError);
  assert.throws(() => parseRemoteMessage({ t: 'call', id: '1', channel: 'x' }), ProtocolError);
  assert.throws(() => parseRemoteMessage({ t: 'reply', id: '1', result: { ok: 'maybe' } }), ProtocolError);
  assert.throws(() => parseRemoteMessage({ t: 'auth', clientId: 1, clientName: 'n', token: 't' }), ProtocolError);
});

test('a failed reply keeps the code and the retryable flag from the other machine', () => {
  const parsed = parseRemoteMessage({
    t: 'reply',
    id: '7',
    result: { ok: false, error: { code: 'DOCKER_UNAVAILABLE', message: 'down', retryable: true } },
  });
  assert.equal(parsed.t, 'reply');
  if (parsed.t !== 'reply' || parsed.result.ok) throw new Error('expected a failed reply');
  assert.equal(parsed.result.error.code, 'DOCKER_UNAVAILABLE');
  assert.equal(parsed.result.error.retryable, true);
});

test('a ticket survives the round trip, non-ascii names included', () => {
  const original = ticket();
  const decoded = decodeRemoteTicket(encodeRemoteTicket(original));
  assert.deepEqual(decoded, original);
});

test('a ticket that was mangled, truncated or aimed at another version is refused', () => {
  const encoded = encodeRemoteTicket(ticket());
  assert.equal(decodeRemoteTicket(encoded.slice(0, encoded.length - 4)), null);
  assert.equal(decodeRemoteTicket(encoded.replace('CCD1.', '')), null);
  assert.equal(decodeRemoteTicket('CCD1.!!!!'), null);
  assert.equal(decodeRemoteTicket(''), null);
  assert.equal(decodeRemoteTicket(encodeRemoteTicket(ticket({ fingerprint: 'short' }))), null);
  assert.equal(decodeRemoteTicket(encodeRemoteTicket(ticket({ instanceId: 'nope' }))), null);
  assert.equal(decodeRemoteTicket(encodeRemoteTicket(ticket({ code: 'lower' }))), null);
  assert.equal(decodeRemoteTicket(encodeRemoteTicket(ticket({ port: 0 }))), null);
});

test('pairing codes read the way they are typed', () => {
  assert.equal(normalizePairingCode('abc de-fgh j'), 'ABCDEFGHJ');
  assert.equal(normalizePairingCode('OoIi01'), '', 'characters that get misread are never part of a code');
  assert.equal(normalizePairingCode('!!!'), '');
  assert.equal(formatPairingCode('23456789AB'), '23456-789AB');
  assert.equal(normalizePairingCode('23456789AB').length, PAIRING_CODE_LENGTH);
});

test('addresses parse the shapes people actually type', () => {
  assert.deepEqual(parseRemoteAddress('192.168.1.5'), { host: '192.168.1.5', port: DEFAULT_REMOTE_PORT });
  assert.deepEqual(parseRemoteAddress('192.168.1.5:9000'), { host: '192.168.1.5', port: 9000 });
  assert.deepEqual(parseRemoteAddress('desk.local:47713'), { host: 'desk.local', port: 47713 });
  assert.deepEqual(parseRemoteAddress('[fd00::1]:9000'), { host: 'fd00::1', port: 9000 });
  assert.deepEqual(parseRemoteAddress('fd00::1'), { host: 'fd00::1', port: DEFAULT_REMOTE_PORT });
  assert.deepEqual(parseRemoteAddress('https://desk.local:9000'), { host: 'desk.local', port: 9000 });
  assert.equal(parseRemoteAddress(''), null);
  assert.equal(parseRemoteAddress('desk:99999'), null);
  assert.equal(formatRemoteAddress({ host: 'fd00::1', port: 9000 }), '[fd00::1]:9000');
  assert.equal(formatRemoteAddress({ host: '10.0.0.2', port: 9000 }), '10.0.0.2:9000');
});

test('names and fingerprints are shown in a readable, bounded form', () => {
  assert.equal(normalizeRemoteName('  work\u0000  desk  '), 'work desk');
  assert.equal(normalizeRemoteName('x'.repeat(200)).length, 48);
  assert.equal(formatFingerprint('abcd1234'), 'ABCD 1234');
});
