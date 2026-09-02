import type { BrowserWindow } from 'electron';

/**
 * Pushes an event at the renderer, skipping the send when the window is gone.
 * Every module that talks to the window outlives it — the user can close the
 * window while a build, a provision or a terminal is still streaming — so the
 * "is it still there?" check belongs in one place rather than at every send.
 */
export function sendToWindow(window: BrowserWindow | null, channel: string, ...args: readonly unknown[]): void {
  if (window === null || window.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}
