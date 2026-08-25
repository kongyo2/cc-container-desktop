/** Electron entry point: window, menu, lifecycle. */

import { app, BrowserWindow, Menu, shell } from 'electron';
import { join } from 'node:path';

import { getConfig } from './config/store.ts';
import { closeAllTerminals, setTerminalTarget } from './docker/terminal.ts';
import { ensureImageSources } from './docker/image.ts';
import { registerIpc } from './ipc.ts';
import { describeError, logError, logInfo, setLogTarget } from './logger.ts';

const isDev = !app.isPackaged;

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Claude Code docs',
          click: () => {
            void shell.openExternal('https://code.claude.com/docs');
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#16161a',
    autoHideMenuBar: true,
    title: 'Claude Code Container Workbench',
    // Packaged builds take their icon from the executable; in development there
    // is no executable to take it from, so point at the source asset.
    ...(isDev ? { icon: join(app.getAppPath(), 'build', 'icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload script only needs `ipcRenderer`, so the renderer can stay
      // fully sandboxed with no Node integration at all.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Anything that tries to open a new window goes to the real browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl !== undefined && devUrl !== '') {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  setLogTarget(window);
  setTerminalTarget(window);
  window.on('closed', () => {
    setLogTarget(null);
    setTerminalTarget(null);
  });

  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing === undefined) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  const start = async (): Promise<void> => {
    await app.whenReady();
    buildMenu();
    registerIpc(app.getVersion());

    try {
      ensureImageSources();
    } catch (error) {
      logError('app', `イメージソースを展開できませんでした / could not seed image sources: ${describeError(error)}`);
    }

    createWindow();

    const config = getConfig();
    logInfo(
      'app',
      `起動しました / started — container=${config.containerName} image=${config.imageTag} volume=${config.volumeName}`,
    );

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  };

  start().catch((error: unknown) => {
    logError('app', describeError(error));
  });

  app.on('before-quit', () => {
    closeAllTerminals();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
