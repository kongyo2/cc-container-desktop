import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createServer, connect } from 'node:tls';
import type { Server, TLSSocket } from 'node:tls';

import { generate } from 'selfsigned';

import { RemoteChannel } from '../../src/main/remote/channel.ts';
import type { CallMessage, EventMessage } from '../../src/main/remote/protocol.ts';
import { pairingProof, sameProof } from '../../src/main/remote/pairing.ts';

interface Pair {
  readonly host: RemoteChannel;
  readonly client: RemoteChannel;
  readonly events: EventMessage[];
  close(): Promise<void>;
}

async function connectedPair(onCall: (channel: RemoteChannel, message: CallMessage) => void): Promise<Pair> {
  const pems = await generate([{ name: 'commonName', value: 'test' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
  });

  let host: RemoteChannel | null = null;
  const server: Server = createServer({ key: pems.private, cert: pems.cert, minVersion: 'TLSv1.3' });
  const accepted = new Promise<RemoteChannel>((resolve) => {
    server.on('secureConnection', (socket: TLSSocket) => {
      const channel = new RemoteChannel(socket, {
        onCall: (message) => onCall(channel, message),
        onClose: () => undefined,
      });
      host = channel;
      resolve(channel);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const pending = connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' });
    pending.once('secureConnect', () => resolve(pending));
    pending.once('error', reject);
  });

  const events: EventMessage[] = [];
  const client = new RemoteChannel(socket, {
    onEvent: (message) => events.push(message),
    onClose: () => undefined,
  });

  return {
    host: await accepted,
    client,
    events,
    close: async () => {
      client.close('done');
      host?.close('done');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('a call crosses a real TLS socket and comes back as a value or as the original failure', async () => {
  const pair = await connectedPair((channel, message) => {
    if (message.channel === 'boom') {
      channel.reply(message.id, {
        ok: false,
        error: { code: 'DOCKER_UNAVAILABLE', message: 'Docker is down', retryable: true },
      });
      return;
    }
    channel.reply(message.id, { ok: true, value: { echoed: message.args } });
  });

  try {
    assert.deepEqual(await pair.client.call('app:snapshot', [1, 'two', null]), { echoed: [1, 'two', null] });

    await assert.rejects(pair.client.call('boom', []), (error: unknown) => {
      assert.equal((error as { error: { code: string; retryable: boolean } }).error.code, 'DOCKER_UNAVAILABLE');
      assert.equal((error as { error: { retryable: boolean } }).error.retryable, true);
      return true;
    });

    pair.host.event('evt:log', { stream: 'app', level: 'info', text: 'こんにちは', at: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pair.events.length, 1);
    assert.equal(pair.events[0]?.channel, 'evt:log');
  } finally {
    await pair.close();
  }
});

test('a multi-megabyte transfer arrives byte for byte, with its metadata', async () => {
  const payload = randomBytes(3 * 1024 * 1024 + 7);
  const pair = await connectedPair((channel, message) => {
    if (message.channel !== 'pull') return;
    const id = String(message.args[0]);
    void channel
      .sendStream(id, { folderBase: 'work space' }, Readable.from([payload.subarray(0, 1), payload.subarray(1)]))
      .then(
        () => {
          channel.reply(message.id, { ok: true, value: null });
          return null;
        },
        (error: unknown) => {
          channel.reply(message.id, {
            ok: false,
            error: { code: 'APP_ERROR', message: String(error), retryable: false },
          });
          return null;
        },
      );
  });

  try {
    const transferId = pair.client.newTransferId();
    const incoming = pair.client.receiveStream(transferId);
    const call = pair.client.call('pull', [transferId]);

    const chunks: Buffer[] = [];
    for await (const chunk of incoming.stream) chunks.push(chunk as Buffer);
    await call;

    assert.deepEqual(await incoming.meta, { folderBase: 'work space' });
    assert.equal(Buffer.concat(chunks).equals(payload), true);
  } finally {
    await pair.close();
  }
});

test('a handler that throws closes the link instead of taking the process down', async () => {
  const pair = await connectedPair(() => {
    throw new Error('the state directory is read-only');
  });
  const pending = pair.client.call('task:start', ['t1']);
  await assert.rejects(pending, /the remote link dropped/u);
  assert.equal(pair.host.closed, true);
  await pair.close();
});

test('a transfer nobody will send is dropped instead of lingering on the channel', async () => {
  const pair = await connectedPair(() => undefined);
  try {
    const incoming = pair.client.receiveStream('t1');
    pair.client.cancelIncoming('t1', 'the host refused');

    assert.equal(await incoming.meta, null);
    await assert.rejects(
      (async () => {
        for await (const chunk of incoming.stream) void chunk;
      })(),
      /the host refused/u,
    );
    assert.notEqual(pair.client.receiveStream('t1').stream, incoming.stream, 'the entry is gone, not reused');
    pair.client.cancelIncoming('t1', 'again');
  } finally {
    await pair.close();
  }
});

test('a dropped link fails the calls that were still in flight', async () => {
  const pair = await connectedPair(() => undefined);
  const pending = pair.client.call('app:snapshot', []);
  pair.host.close('host went away');
  await assert.rejects(pending, /リモート接続が切れました|the remote link dropped/u);
  await pair.close();
});

test('a pairing proof binds the code, the role and the whole transcript', () => {
  const fingerprint = 'a'.repeat(64);
  const parts = ['server-nonce', 'client-nonce', 'cli_1'];
  const mine = pairingProof('23456789AB', 'client', fingerprint, parts);

  assert.equal(mine, pairingProof('23456789AB', 'client', fingerprint, parts));
  assert.notEqual(mine, pairingProof('23456789AB', 'server', fingerprint, parts));
  assert.notEqual(mine, pairingProof('OTHERCODE7', 'client', fingerprint, parts));
  assert.notEqual(mine, pairingProof('23456789AB', 'client', 'b'.repeat(64), parts));
  assert.notEqual(mine, pairingProof('23456789AB', 'client', fingerprint, ['server-nonce', 'client-nonce', 'cli_2']));
  assert.equal(sameProof(mine, mine), true);
  assert.equal(sameProof(mine, `${mine}x`), false);
  assert.equal(sameProof(mine, mine.replace(/.$/u, '!')), false);
});
