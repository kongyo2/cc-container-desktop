/**
 * Routes terminal output to whichever view owns that session id.
 *
 * The main process starts streaming as soon as the exec attaches, which can be
 * before `termOpen` has even resolved in the renderer — so a view cannot simply
 * subscribe once it knows its id without losing the first frames. This module
 * subscribes once at startup and buffers per id until a handler shows up.
 */

import type { TerminalExit } from '../../shared/types.ts';

type DataHandler = (data: string) => void;
type ExitHandler = (exit: TerminalExit) => void;

const buffers = new Map<string, string[]>();
const dataHandlers = new Map<string, DataHandler>();
const exitHandlers = new Map<string, ExitHandler>();
const pendingExits = new Map<string, TerminalExit>();

let started = false;

export function startTerminalBus(): void {
  if (started) return;
  started = true;

  window.cc.onTerminalData(({ id, data }) => {
    const handler = dataHandlers.get(id);
    if (handler !== undefined) {
      handler(data);
      return;
    }
    const buffer = buffers.get(id);
    if (buffer === undefined) buffers.set(id, [data]);
    else buffer.push(data);
  });

  window.cc.onTerminalExit((exit) => {
    const handler = exitHandlers.get(exit.id);
    if (handler !== undefined) handler(exit);
    else pendingExits.set(exit.id, exit);
  });
}

/** Attaches handlers for `id` and replays anything that arrived first. */
export function attachTerminal(id: string, onData: DataHandler, onExit: ExitHandler): () => void {
  dataHandlers.set(id, onData);
  exitHandlers.set(id, onExit);

  const buffered = buffers.get(id);
  if (buffered !== undefined) {
    buffers.delete(id);
    for (const chunk of buffered) onData(chunk);
  }
  const exit = pendingExits.get(id);
  if (exit !== undefined) {
    pendingExits.delete(id);
    onExit(exit);
  }

  return () => {
    dataHandlers.delete(id);
    exitHandlers.delete(id);
    buffers.delete(id);
    pendingExits.delete(id);
  };
}
