import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invokeFromRemote, invokeRouted, registerCommand, setRemoteRouter } from '../../src/main/commands.ts';
import type { RemoteRouter } from '../../src/main/commands.ts';

interface Sent {
  readonly channel: string;
  readonly args: readonly unknown[];
  readonly timeoutMs: number | null | undefined;
}

class FakeRouter implements RemoteRouter {
  engaged = false;
  online = false;
  routeGeneration = 0;
  readonly sent: Sent[] = [];

  requireOnline(): void {
    if (!this.online) throw new Error('REMOTE_OFFLINE');
  }

  call(channel: string, args: readonly unknown[], timeoutMs?: number | null): Promise<unknown> {
    this.sent.push({ channel, args, timeoutMs });
    return Promise.resolve('from the peer');
  }
}

function withRouter(): FakeRouter {
  const router = new FakeRouter();
  setRemoteRouter(router);
  return router;
}

test('a request goes to the machine the window is driving, and home when it is driving none', async () => {
  const router = withRouter();
  registerCommand('t:plain', () => 'from here', { timeoutMs: 1234 });

  assert.equal(await invokeRouted('t:plain', []), 'from here');

  router.engaged = true;
  router.online = true;
  assert.equal(await invokeRouted('t:plain', [7]), 'from the peer');
  assert.deepEqual(router.sent, [{ channel: 't:plain', args: [7], timeoutMs: 1234 }]);

  setRemoteRouter(null);
});

test('an engaged but offline link fails every request except the read the gate needs', async () => {
  const router = withRouter();
  router.engaged = true;
  router.online = false;
  registerCommand('t:action', () => 'ran here');
  registerCommand('t:status', () => 'local status', { offlineFallback: true });

  await assert.rejects(invokeRouted('t:action', []), /REMOTE_OFFLINE/u);
  assert.equal(await invokeRouted('t:status', []), 'local status');
  assert.equal(router.sent.length, 0);

  setRemoteRouter(null);
});

test('a read that finishes after the route changed is taken again on the new route', async () => {
  const router = withRouter();
  let ran = 0;
  registerCommand(
    't:read',
    () => {
      ran += 1;
      if (ran === 1) {
        router.engaged = true;
        router.online = true;
        router.routeGeneration += 1;
      }
      return 'stale local read';
    },
    { reroute: true },
  );

  assert.equal(await invokeRouted('t:read', []), 'from the peer');
  assert.equal(ran, 1, 'the second attempt went to the peer instead of running here again');

  setRemoteRouter(null);
});

test('a local-only request stays home even while another machine is being driven', async () => {
  const router = withRouter();
  router.engaged = true;
  router.online = true;
  registerCommand('t:here', () => 'always here', { local: true });

  assert.equal(await invokeRouted('t:here', []), 'always here');
  assert.equal(router.sent.length, 0);

  setRemoteRouter(null);
});

test('requests a controller must not make here are refused, and the rest carry who asked', async () => {
  registerCommand('t:refused', () => 'should not run', { denyRemote: true });
  const origin = { kind: 'remote', sessionId: 's1', clientId: 'c1', clientName: 'desk' } as const;

  await assert.rejects(invokeFromRemote('t:refused', [], origin), /REMOTE_DENIED|つないでいる側/u);
  await assert.rejects(invokeFromRemote('t:unknown', [], origin), /知らない操作|unknown request/u);

  let seen: string | null = null;
  registerCommand('t:allowed', () => {
    seen = 'ran';
    return 'ok';
  });
  assert.equal(await invokeFromRemote('t:allowed', [], origin), 'ok');
  assert.equal(seen, 'ran');
});
