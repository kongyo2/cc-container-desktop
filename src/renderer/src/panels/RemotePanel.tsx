import { Copy, Link2, Link2Off, Radar, RefreshCw, Trash2, Unplug, UserMinus } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import {
  decodeRemoteTicket,
  formatFingerprint,
  formatPairingCode,
  normalizePairingCode,
  shortFingerprint,
} from '../../../shared/remote.ts';
import type {
  RemoteDiscoveredView,
  RemoteHostingView,
  RemoteLinkView,
  RemotePeerView,
  RemoteStatus,
} from '../../../shared/remote.ts';
import { Check, DeferredTextField, Field, Pill, Section, formatTime } from '../components/ui.tsx';
import type { Tone } from '../components/ui.tsx';
import { useT } from '../i18n.ts';
import type { Translator } from '../i18n.ts';
import { useApp } from '../store.ts';

function linkTone(state: RemoteLinkView['state']): Tone {
  if (state === 'online') return 'ok';
  if (state === 'connecting') return 'warn';
  if (state === 'error') return 'err';
  return 'idle';
}

function linkLabel(t: Translator, link: RemoteLinkView): string {
  switch (link.state) {
    case 'online':
      return `${t('remoteLinkOnline')}: ${link.peerName ?? ''}`;
    case 'connecting':
      return t('remoteLinkConnecting');
    case 'error':
      return t('remoteLinkError');
    default:
      return t('remoteLinkOffline');
  }
}

function useCopy(): (text: string) => void {
  const t = useT();
  const setToast = useApp((state) => state.setToast);
  return (text: string) => {
    void window.cc.clipboardWrite(text);
    setToast(t('commonCopied'));
  };
}

function CopyRow({ value, label }: { value: string; label: string }): JSX.Element {
  const t = useT();
  const copy = useCopy();
  return (
    <div className="inline-input">
      <input type="text" value={value} readOnly spellCheck={false} aria-label={label} />
      <button className="btn sm" type="button" onClick={() => copy(value)}>
        <Copy size={13} /> {t('commonCopy')}
      </button>
    </div>
  );
}

function LinkStatus({ link }: { link: RemoteLinkView }): JSX.Element {
  const t = useT();
  const run = useApp((state) => state.run);
  const busy = useApp((state) => state.busy) !== null;

  return (
    <Section title={t('remoteTitle')}>
      <p className="hint">{t('remoteIntro')}</p>
      <div className="row" data-testid="remote-link">
        <Pill tone={linkTone(link.state)}>{linkLabel(t, link)}</Pill>
        {link.address === null ? null : <span className="tag">{link.address}</span>}
        {link.peerVersion === null ? null : <span className="tag">v{link.peerVersion}</span>}
        {link.state === 'connecting' && link.attempt > 1 ? (
          <span className="tag warn">
            {t('remoteAttempt')} {link.attempt}
          </span>
        ) : null}
        <span className="spacer" />
        {link.state === 'offline' ? null : (
          <button
            className="btn sm"
            type="button"
            disabled={busy}
            onClick={() => void run('remote', () => window.cc.remoteDisconnect())}
            data-testid="remote-disconnect"
          >
            <Unplug size={13} /> {t('remoteDisconnect')}
          </button>
        )}
      </div>
      {link.error === null ? null : <p className="hint err">{link.error}</p>}
    </Section>
  );
}

function Invite({ hosting }: { hosting: RemoteHostingView }): JSX.Element {
  const t = useT();
  const run = useApp((state) => state.run);
  const busy = useApp((state) => state.busy) !== null;
  const invite = hosting.invite;

  if (invite === null) {
    return (
      <div className="row">
        <button
          className="btn primary sm"
          type="button"
          disabled={busy}
          onClick={() => void run('remote', () => window.cc.remoteInviteCreate())}
          data-testid="remote-invite"
        >
          <Link2 size={13} /> {t('remoteInviteCreate')}
        </button>
        <span className="hint">{t('remoteInviteHint')}</span>
      </div>
    );
  }

  return (
    <div className="entry-card" data-testid="remote-invite-open">
      <div className="entry-head">
        <strong className="remote-code">{formatPairingCode(invite.code)}</strong>
        <span className="tag">
          {t('remoteInviteExpires')} {formatTime(invite.expiresAt)}
        </span>
        <span className="spacer" />
        <button
          className="btn sm"
          type="button"
          disabled={busy}
          onClick={() => void run('remote', () => window.cc.remoteInviteCancel())}
        >
          <Link2Off size={13} /> {t('remoteInviteCancel')}
        </button>
      </div>
      <Field label={t('remoteInviteTicket')} hint={t('remoteInviteTicketHint')}>
        <CopyRow value={invite.ticket} label={t('remoteInviteTicket')} />
      </Field>
    </div>
  );
}

function Hosting({ status }: { status: RemoteStatus }): JSX.Element {
  const t = useT();
  const run = useApp((state) => state.run);
  const busy = useApp((state) => state.busy) !== null;
  const { hosting, identity, link } = status;
  const driving = link.state === 'online';

  const save = (patch: Parameters<typeof window.cc.remoteHostingSave>[0]): void => {
    void run('remote', () => window.cc.remoteHostingSave(patch));
  };

  return (
    <Section
      title={driving ? `${t('remoteHostingTitle')} — ${identity.name}` : t('remoteHostingTitle')}
      actions={
        <Pill tone={hosting.listening ? 'ok' : 'idle'}>
          {hosting.listening ? `:${hosting.boundPort ?? hosting.port}` : t('remoteHostingOff')}
        </Pill>
      }
    >
      <p className="hint">{t('remoteHostingHint')}</p>
      {driving ? <p className="hint warn">{t('remoteWarnLockout')}</p> : null}

      <Check label={t('remoteHostingEnabled')} checked={hosting.enabled} onChange={(enabled) => save({ enabled })} />
      <div className="grid2">
        <DeferredTextField
          label={t('remoteName')}
          value={identity.name}
          mono={false}
          onCommit={(name) => save({ name })}
        />
        <Field label={t('remotePort')} hint={t('remotePortHint')}>
          <input
            type="number"
            min={1}
            max={65535}
            value={hosting.port}
            onChange={(event) => {
              const port = Number.parseInt(event.target.value, 10);
              if (Number.isInteger(port) && port > 0 && port <= 65535) save({ port });
            }}
          />
        </Field>
      </div>
      <Check label={t('remoteDiscovery')} checked={hosting.discovery} onChange={(discovery) => save({ discovery })} />
      <p className="hint">{t('remoteDiscoveryHint')}</p>

      {hosting.problem === null ? null : (
        <p className="hint err">
          {t('remoteHostingProblem')}: {hosting.problem}
        </p>
      )}

      <Field label={t('remoteAddresses')}>
        <CopyRow value={hosting.addresses.join(' ')} label={t('remoteAddresses')} />
      </Field>
      <Field label={t('remoteFingerprint')} hint={t('remoteFingerprintHint')}>
        <CopyRow value={formatFingerprint(identity.fingerprint)} label={t('remoteFingerprint')} />
      </Field>

      <Invite hosting={hosting} />

      <h3 className="remote-sub">{t('remoteClients')}</h3>
      {hosting.clients.length === 0 ? <p className="hint">{t('remoteClientsEmpty')}</p> : null}
      {hosting.clients.map((client) => (
        <div className="entry-card" key={client.id} data-client-id={client.id}>
          <div className="entry-head">
            <strong>{client.name === '' ? client.id : client.name}</strong>
            {client.online ? <Pill tone="ok">{t('remoteClientOnline')}</Pill> : null}
            <span className="tag">{client.lastAddress ?? t('commonNone')}</span>
            <span className="tag">
              {t('remoteLastConnected')} {formatTime(client.lastSeenAt)}
            </span>
            <span className="spacer" />
            <button
              className="btn danger sm"
              type="button"
              disabled={busy}
              onClick={() => void run('remote', () => window.cc.remoteClientRevoke(client.id))}
            >
              <UserMinus size={13} /> {t('remoteRevoke')}
            </button>
          </div>
        </div>
      ))}
    </Section>
  );
}

function Discovered({
  peers,
  scanning,
  onPick,
}: {
  peers: readonly RemoteDiscoveredView[];
  scanning: boolean;
  onPick: (peer: RemoteDiscoveredView) => void;
}): JSX.Element {
  const t = useT();
  const run = useApp((state) => state.run);
  const busy = useApp((state) => state.busy) !== null;

  return (
    <>
      <div className="row">
        <button
          className="btn sm"
          type="button"
          disabled={busy}
          onClick={() => void run('remote', () => window.cc.remoteScan())}
          data-testid="remote-scan"
        >
          <Radar size={13} /> {scanning ? t('remoteScanning') : t('remoteScan')}
        </button>
        <span className="hint">{t('remoteDiscovered')}</span>
      </div>
      {peers.length === 0 ? <p className="hint">{t('remoteDiscoveredEmpty')}</p> : null}
      {peers.map((peer) => (
        <div className="entry-card" key={peer.id} data-peer-id={peer.id}>
          <div className="entry-head">
            <strong>{peer.name}</strong>
            <span className="tag">{`${peer.host}:${peer.port}`}</span>
            <span className="tag">{shortFingerprint(peer.fingerprint)}</span>
            {peer.paired ? <Pill tone="ok">{t('remotePairDone')}</Pill> : null}
            <span className="spacer" />
            {peer.paired ? (
              <button
                className="btn sm"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run('remote', () =>
                    window.cc.remoteConnect({ peerId: peer.id, address: `${peer.host}:${peer.port}` }),
                  )
                }
              >
                <Link2 size={13} /> {t('remoteConnect')}
              </button>
            ) : (
              <button className="btn sm" type="button" onClick={() => onPick(peer)}>
                <Link2 size={13} /> {t('remotePair')}
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

function SavedPeers({ peers, link }: { peers: readonly RemotePeerView[]; link: RemoteLinkView }): JSX.Element {
  const t = useT();
  const run = useApp((state) => state.run);
  const busy = useApp((state) => state.busy) !== null;

  return (
    <>
      <h3 className="remote-sub">{t('remotePeers')}</h3>
      {peers.length === 0 ? <p className="hint">{t('remotePeersEmpty')}</p> : null}
      {peers.map((peer) => {
        const active = link.peerId === peer.id && link.state !== 'offline';
        return (
          <div className="entry-card" key={peer.id} data-saved-peer={peer.id}>
            <div className="entry-head">
              <strong>{peer.name}</strong>
              {active ? <Pill tone={linkTone(link.state)}>{linkLabel(t, link)}</Pill> : null}
              <span className="tag">{shortFingerprint(peer.fingerprint)}</span>
              <span className="tag">
                {t('remoteLastConnected')} {formatTime(peer.lastConnectedAt)}
              </span>
              <span className="spacer" />
              <button
                className="btn sm"
                type="button"
                disabled={busy || active}
                onClick={() => void run('remote', () => window.cc.remoteConnect({ peerId: peer.id, address: '' }))}
                data-testid="remote-connect"
              >
                <Link2 size={13} /> {t('remoteConnect')}
              </button>
              <button
                className="btn danger sm"
                type="button"
                disabled={busy}
                onClick={() => void run('remote', () => window.cc.remotePeerForget(peer.id))}
              >
                <Trash2 size={13} /> {t('remoteForget')}
              </button>
            </div>
            <div className="entry-addresses">{peer.addresses.join('  ·  ')}</div>
          </div>
        );
      })}
    </>
  );
}

function PairForm({ address, setAddress }: { address: string; setAddress: (value: string) => void }): JSX.Element {
  const t = useT();
  const run = useApp((state) => state.run);
  const setToast = useApp((state) => state.setToast);
  const busy = useApp((state) => state.busy) !== null;
  const [ticket, setTicket] = useState('');
  const [code, setCode] = useState('');

  const parsed = ticket.trim() === '' ? null : decodeRemoteTicket(ticket);
  const effectiveCode = code === '' ? (parsed?.code ?? '') : code;

  const pair = (): void => {
    void (async () => {
      const done = await run('remote', () => window.cc.remotePair({ ticket: ticket.trim(), address, code }));
      if (done === null) return;
      setTicket('');
      setCode('');
      setAddress('');
      setToast(t('remotePairDone'));
    })();
  };

  return (
    <div className="entry-card">
      <Field label={t('remotePairTicket')} hint={t('remoteInviteTicketHint')}>
        <textarea
          rows={2}
          value={ticket}
          spellCheck={false}
          placeholder="CCD1.…"
          onChange={(event) => setTicket(event.target.value)}
          data-testid="remote-ticket"
        />
      </Field>
      {parsed === null ? null : (
        <p className="hint">
          {parsed.name} · {parsed.addresses.join(' ')} · {shortFingerprint(parsed.fingerprint)}
        </p>
      )}
      <div className="grid2">
        <Field label={t('remotePairAddress')} hint={t('remotePairAddressHint')}>
          <input
            type="text"
            value={address}
            spellCheck={false}
            placeholder="192.168.1.20:47713"
            onChange={(event) => setAddress(event.target.value)}
            data-testid="remote-address"
          />
        </Field>
        <Field label={t('remotePairCode')}>
          <input
            type="text"
            value={code}
            spellCheck={false}
            placeholder="ABCDE-FGHJK"
            onChange={(event) => setCode(normalizePairingCode(event.target.value))}
            data-testid="remote-code"
          />
        </Field>
      </div>
      <div className="row">
        <button
          className="btn primary sm"
          type="button"
          disabled={busy || effectiveCode === '' || (parsed === null && address.trim() === '')}
          onClick={pair}
          data-testid="remote-pair"
        >
          <Link2 size={13} /> {t('remotePair')}
        </button>
      </div>
    </div>
  );
}

export function RemotePanel(): JSX.Element {
  const t = useT();
  const snapshot = useApp((state) => state.snapshot);
  const refresh = useApp((state) => state.refresh);
  const [address, setAddress] = useState('');

  if (snapshot === null) return <p className="hint">{t('commonRunning')}</p>;
  const { remote } = snapshot;

  return (
    <>
      <LinkStatus link={remote.link} />

      <Section
        title={t('remoteConnectTitle')}
        actions={
          <button className="btn ghost sm" type="button" onClick={() => void refresh()}>
            <RefreshCw size={13} /> {t('commonRefresh')}
          </button>
        }
      >
        <p className="hint">{t('remoteConnectHint')}</p>
        <Discovered
          peers={remote.discovered}
          scanning={remote.scanning}
          onPick={(peer) => setAddress(`${peer.host}:${peer.port}`)}
        />
        <PairForm address={address} setAddress={setAddress} />
        <SavedPeers peers={remote.peers} link={remote.link} />
      </Section>

      <Hosting status={remote} />
    </>
  );
}
