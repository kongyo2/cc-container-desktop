import type { BrowserWindow } from 'electron';

export function sendToWindow(window: BrowserWindow | null, channel: string, ...args: readonly unknown[]): void {
  if (window === null || window.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}
