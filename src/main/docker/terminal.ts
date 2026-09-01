import { StringDecoder } from 'node:string_decoder';
import type { Container, Exec } from 'dockerode';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';

import { CONTAINER_TERMINAL_RUNTIME, CONTAINER_WORKSPACE, sanitizeSessionName } from '../../shared/presets.ts';
import { EVENTS } from '../../shared/ipc.ts';
import type { OpenTerminalRequest, OpenTerminalResult } from '../../shared/types.ts';
import { claudeLaunchCommand } from '../claude/provision.ts';
import { describeError, logWarn } from '../logger.ts';
import { containerHandle, execCapture, listTmuxSessions } from './container.ts';
import type { BrowserWindow } from 'electron';

interface Session {
  readonly id: string;
  readonly stream: Duplex;
  readonly exec: Exec;
  readonly container: Container;
  cols: number;
  rows: number;
}

const sessions = new Map<string, Session>();

const closing = new Set<Promise<void>>();
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

function tmuxCommandFor(request: OpenTerminalRequest, sessionName: string, sessionId: string | null): string {
  const workspace = shellQuote(CONTAINER_WORKSPACE);

  if (sessionId !== null) return `tmux attach-session -d -t ${shellQuote(sessionId)}`;

  const attachOrCreate = `tmux new-session -A -D -s ${shellQuote(sessionName)} -c ${workspace}`;
  if (request.kind === 'claude') return `${attachOrCreate} ${shellQuote(claudeLaunchCommand())}`;
  return attachOrCreate;
}

function runFilePath(id: string): string {
  return `${CONTAINER_TERMINAL_RUNTIME}/${id}`;
}

function wrapCommand(id: string, command: string): readonly string[] {
  const dir = shellQuote(CONTAINER_TERMINAL_RUNTIME);
  const file = shellQuote(runFilePath(id));
  const partial = shellQuote(`${runFilePath(id)}.partial`);
  const record =
    `mkdir -p ${dir} 2>/dev/null; ` +
    `printf '%s\\n%s\\n' "$$" "$(tty)" > ${partial} 2>/dev/null && mv -f ${partial} ${file} 2>/dev/null`;
  return ['bash', '-lc', `${record}; exec ${command}`];
}

function closeScript(id: string): string {
  const file = shellQuote(runFilePath(id));
  return `
f=${file}
i=0
while [ ! -f "$f" ] && [ "$i" -lt 30 ]; do
  i=$((i + 1))
  sleep 0.1
done
[ -f "$f" ] || exit 0
pid=$(sed -n 1p "$f" 2>/dev/null)
tty=$(sed -n 2p "$f" 2>/dev/null)
rm -f "$f"
case "$pid" in ''|*[!0-9]*) exit 0 ;; esac
[ "$(readlink -f "/proc/$pid/fd/0" 2>/dev/null)" = "$tty" ] || exit 0
tmux detach-client -t "$tty" >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e "/proc/$pid" ] || exit 0
  sleep 0.1
done
[ "$(readlink -f "/proc/$pid/fd/0" 2>/dev/null)" = "$tty" ] && kill -HUP "$pid" 2>/dev/null
exit 0
`;
}

async function releaseInContainer(container: Container, id: string): Promise<void> {
  try {
    await execCapture(['bash', '-c', closeScript(id)], { workdir: '/', container });
  } catch (error) {
    logWarn('app', `ターミナルの後始末をスキップしました / terminal cleanup skipped: ${describeError(error)}`);
  }
}

function sizeOf(request: OpenTerminalRequest): { cols: number; rows: number } {
  const cols = Number.isFinite(request.cols) && request.cols > 0 ? Math.floor(request.cols) : 80;
  const rows = Number.isFinite(request.rows) && request.rows > 0 ? Math.floor(request.rows) : 24;
  return { cols, rows };
}

async function resolveSessionId(request: OpenTerminalRequest): Promise<string | null> {
  if (request.kind !== 'attach' || request.sessionId === undefined) return null;

  const live = await listTmuxSessions();
  const found = live.find((session) => session.id === request.sessionId && session.name === request.sessionName);
  if (found === undefined) {
    throw new Error(
      `セッション ${request.sessionName} はもう存在しません。一覧を更新してください / session ${request.sessionName} is gone — refresh the list`,
    );
  }
  return found.id;
}

export async function openTerminal(request: OpenTerminalRequest): Promise<OpenTerminalResult> {
  const sessionId = await resolveSessionId(request);
  const sessionName = sessionId === null ? sanitizeSessionName(request.sessionName) : request.sessionName;
  const { cols, rows } = sizeOf(request);
  const id = randomUUID();

  const command = request.kind === 'shell' ? 'bash -l' : tmuxCommandFor(request, sessionName, sessionId);

  const container = containerHandle();
  const exec = await container.exec({
    Cmd: [...wrapCommand(id, command)],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    ConsoleSize: [rows, cols],
    WorkingDir: CONTAINER_WORKSPACE,
    Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', 'LANG=C.UTF-8'],
  });

  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  sessions.set(id, { id, stream, exec, container, cols: 0, rows: 0 });

  const decoder = new StringDecoder('utf8');
  stream.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text === '' || !sessions.has(id)) return;
    send(EVENTS.termData, { id, data: text });
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
      await releaseInContainer(container, id);
    })();
  };

  stream.on('end', finish);
  stream.on('close', finish);
  stream.on('error', (error: Error) => {
    logWarn('app', `ターミナルが切断されました / terminal stream error: ${describeError(error)}`);
    finish();
  });

  await resizeTerminal(id, cols, rows);
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
  if (session.cols === cols && session.rows === rows) return;

  const previousCols = session.cols;
  const previousRows = session.rows;
  session.cols = cols;
  session.rows = rows;
  try {
    await session.exec.resize({ w: cols, h: rows });
  } catch (error) {
    session.cols = previousCols;
    session.rows = previousRows;
    logWarn('app', `リサイズできませんでした / resize failed: ${describeError(error)}`);
  }
}

export async function closeTerminal(id: string): Promise<void> {
  const session = sessions.get(id);
  if (session === undefined) return;
  sessions.delete(id);

  const work = (async () => {
    await releaseInContainer(session.container, id);
    session.stream.end();
    session.stream.destroy();
  })();
  closing.add(work);
  try {
    await work;
  } finally {
    closing.delete(work);
  }
}

export async function closeAllTerminals(): Promise<void> {
  const had = sessions.size;
  for (const id of [...sessions.keys()]) {
    void closeTerminal(id).catch(() => undefined);
  }
  if (closing.size > 0) await Promise.all([...closing].map((work) => work.catch(() => undefined)));
  if (had > 0) send(EVENTS.terminalsReset, null);
}
