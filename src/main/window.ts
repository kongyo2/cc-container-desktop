import type { BrowserWindow } from 'electron';

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

export function sendToWindow(window: BrowserWindow | null, channel: string, ...args: readonly unknown[]): void {
  if (window === null || window.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}

export function broadcast(channel: string, ...args: readonly unknown[]): void {
  sendToWindow(mainWindow, channel, ...args);
}
