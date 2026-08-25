import { StringDecoder } from 'node:string_decoder';
import type { Exec } from 'dockerode';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';

import { CONTAINER_WORKSPACE } from '../../shared/presets.ts';
import { EVENTS } from '../../shared/ipc.ts';
import type { OpenTerminalRequest, OpenTerminalResult } from '../../shared/types.ts';
import { claudeLaunchCommand } from '../claude/provision.ts';
import { describeError, logWarn } from '../logger.ts';
import { containerHandle } from './container.ts';
import type { BrowserWindow } from 'electron';

interface Session {
  readonly id: string;
  readonly stream: Duplex;
  readonly exec: Exec;
}

const sessions = new Map<string, Session>();
let target: BrowserWindow | null = null;

export function setTerminalTarget(window: BrowserWindow | null): void {
  target = window;
}

function send(channel: string, payload: unknown): void {
  if (target !== null && !target.isDestroyed()) target.webContents.send(channel, payload);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sanitizeSessionName(name: string): string {
  const cleaned = name.replaceAll(/[.:\s]/gu, '-').trim();
  return cleaned === '' ? 'cc' : cleaned;
}

function commandFor(request: OpenTerminalRequest, sessionName: string): readonly string[] {
  switch (request.kind) {
    case 'claude': {
      const inner = `tmux new-session -A -s ${shellQuote(sessionName)} -c ${shellQuote(CONTAINER_WORKSPACE)} ${shellQuote(claudeLaunchCommand())}`;
      return ['bash', '-lc', inner];
    }
    case 'attach': {
      const inner = `tmux new-session -A -s ${shellQuote(sessionName)} -c ${shellQuote(CONTAINER_WORKSPACE)}`;
      return ['bash', '-lc', inner];
    }
    case 'shell':
      return ['bash', '-l'];
  }
}

export async function openTerminal(request: OpenTerminalRequest): Promise<OpenTerminalResult> {
  const sessionName = sanitizeSessionName(request.sessionName);
  const exec = await containerHandle().exec({
    Cmd: [...commandFor(request, sessionName)],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    WorkingDir: CONTAINER_WORKSPACE,
    Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', 'LANG=C.UTF-8'],
  });

  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  const id = randomUUID();
  sessions.set(id, { id, stream, exec });

  const decoder = new StringDecoder('utf8');
  stream.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text !== '') send(EVENTS.termData, { id, data: text });
  });

  const finish = (): void => {
    if (!sessions.has(id)) return;
    sessions.delete(id);
    void (async () => {
      try {
        const info = (await exec.inspect()) as { ExitCode?: number | null };
        send(EVENTS.termExit, { id, exitCode: info.ExitCode ?? null });
      } catch {
        send(EVENTS.termExit, { id, exitCode: null });
      }
    })();
  };

  stream.on('end', finish);
  stream.on('close', finish);
  stream.on('error', (error: Error) => {
    logWarn('app', `ターミナルが切断されました / terminal stream error: ${describeError(error)}`);
    finish();
  });

  await resizeTerminal(id, request.cols, request.rows);
  return { id, sessionName };
}

export function writeTerminal(id: string, data: string): void {
  const session = sessions.get(id);
  if (session === undefined) return;
  session.stream.write(data);
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  const session = sessions.get(id);
  if (session === undefined) return;
  if (cols <= 0 || rows <= 0) return;
  try {
    await session.exec.resize({ w: cols, h: rows });
  } catch (error) {
    logWarn('app', `リサイズできませんでした / resize failed: ${describeError(error)}`);
  }
}

export function closeTerminal(id: string): void {
  const session = sessions.get(id);
  if (session === undefined) return;
  sessions.delete(id);

  session.stream.end();
  setTimeout(() => session.stream.destroy(), 0);
}

export function closeAllTerminals(): void {
  const had = sessions.size;
  for (const id of [...sessions.keys()]) closeTerminal(id);
  if (had > 0) send(EVENTS.terminalsReset, null);
}
