/**
 * Interactive `docker exec` sessions bridged to xterm.js in the renderer.
 *
 * Claude Code always runs inside tmux. That is the whole reason reattaching
 * works: closing a terminal tab tears down the *exec* (the tmux client), while
 * the tmux server — and the Claude Code process inside it — keeps running in the
 * container. `tmux new-session -A` then attaches to what is already there.
 */

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

/** Wraps a string for safe use inside single quotes in a `bash -lc` command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** tmux session names cannot contain `.` or `:`; anything else is fair game. */
function sanitizeSessionName(name: string): string {
  const cleaned = name.replaceAll(/[.:\s]/gu, '-').trim();
  return cleaned === '' ? 'cc' : cleaned;
}

function commandFor(request: OpenTerminalRequest, sessionName: string): readonly string[] {
  switch (request.kind) {
    case 'claude': {
      // `-A` means "attach if it exists, otherwise create" — one button for both
      // "start" and "reconnect".
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

  // With Tty: true Docker hands back a single un-multiplexed stream, so the bytes
  // can go straight to xterm without demuxing.
  stream.on('data', (chunk: Buffer) => {
    send(EVENTS.termData, { id, data: chunk.toString('utf8') });
  });

  const finish = (): void => {
    if (!sessions.has(id)) return;
    sessions.delete(id);
    void (async () => {
      try {
        const info = (await exec.inspect()) as { ExitCode?: number | null };
        send(EVENTS.termExit, { id, exitCode: info.ExitCode ?? null });
      } catch {
        // The exec record is gone once the container stops; an unknown exit code
        // is still worth reporting so the tab can mark itself finished.
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
    // Racing a resize against a process that just exited is normal, not a fault.
    logWarn('app', `リサイズできませんでした / resize failed: ${describeError(error)}`);
  }
}

export function closeTerminal(id: string): void {
  const session = sessions.get(id);
  if (session === undefined) return;
  sessions.delete(id);
  // Ending stdin drops the tmux *client*; the tmux server and everything running
  // inside it stay alive, which is exactly what reattaching depends on.
  session.stream.end();
  session.stream.destroy();
}

export function closeAllTerminals(): void {
  for (const id of [...sessions.keys()]) closeTerminal(id);
}
