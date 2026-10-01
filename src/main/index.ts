import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { dirname, join } from 'node:path';
import { ClaudeCliClient } from '../analyze/llm.js';
import { currentStatus } from '../analyze/runner.js';
import { loadConfig } from '../config.js';
import { readLiveSessions } from '../ingest/live.js';
import { openDb } from '../store/db.js';
import type { OpenRequest } from '../shared/api.js';
import { resolveShellPath, sessionEnv } from './env.js';
import { PtyManager } from './pty.js';
import { CompanionService } from './service.js';

const TICK_MS = 5000;
const TICK_WHILE_ANALYZING_MS = 1500;

// `companion` run twice focuses the existing window instead of opening a second app.
if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;

app.whenReady().then(() => {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const terminals = new PtyManager();
  const shellPath = resolveShellPath();
  const send = (channel: string, ...args: unknown[]) => win?.webContents.send(channel, ...args);

  const service = new CompanionService({
    db,
    cfg,
    terminals,
    llm: new ClaudeCliClient(db, join(dirname(cfg.dbPath), 'run')),
    loadLive: () => readLiveSessions(cfg.claudeDir),
    env: () => sessionEnv(shellPath),
    onChanged: () => send('changed'),
  });

  terminals.on('data', (id: string, data: string, end: number) => send('term:data', id, data, end));
  terminals.on('exit', (id: string, code: number) => {
    send('term:exit', id, code);
    // The session just ended: pick up what happened in it.
    const sessionId = terminals.get(id)?.sessionId;
    service.refresh();
    void service.analyze({ endedSessionIds: sessionId ? [sessionId] : [] });
    send('changed');
  });

  ipcMain.handle('sessions:list', (_e, q) => service.listSessions(q ?? {}));
  ipcMain.handle('projects:list', () => service.listProjects());
  ipcMain.handle('recap:get', () => service.getRecap());
  ipcMain.handle('recap:regenerate', () => {
    void service.analyze({ force: true });
  });
  ipcMain.handle('session:open', (_e, req: OpenRequest) => service.open(req));
  ipcMain.handle('term:list', () => terminals.list());
  ipcMain.handle('term:replay', (_e, id: string) => terminals.replay(id));
  ipcMain.handle('term:close', (_e, id: string) => terminals.close(id));
  ipcMain.on('term:write', (_e, id: string, data: string) => terminals.write(id, data));
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  // Keep the session list and recap fresh; poll faster while summaries are being written.
  const tick = () => {
    service.refresh();
    send('changed');
    const running = currentStatus(db, cfg)?.state === 'running';
    setTimeout(tick, running ? TICK_WHILE_ANALYZING_MS : TICK_MS);
  };
  service.refresh();
  setTimeout(tick, TICK_MS);
  void service.analyze();

  Menu.setApplicationMenu(buildMenu());
  win = createWindow();

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // Closing the app ends its Claude sessions (they can be resumed later), so confirm first.
  let confirmedQuit = false;
  app.on('before-quit', (e) => {
    const running = terminals.running();
    if (confirmedQuit || !running.length || !win) {
      terminals.closeAll();
      return;
    }
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      message: `${running.length} Claude session${running.length > 1 ? 's are' : ' is'} still running.`,
      detail: 'Quitting ends them. You can resume them later from Sessions.',
    });
    if (choice === 0) {
      confirmedQuit = true;
      app.quit();
    }
  });
});

app.on('window-all-closed', () => app.quit());

/**
 * The Edit roles make copy and paste work in inputs and terminals. There's deliberately no
 * "Close Window" item: ⌘W closes the current session tab, which the window handles itself.
 */
function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ]);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Companion',
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => (win = null));
  // Links open in the browser, never inside the app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(__dirname, '../renderer/index.html'));
  return w;
}
