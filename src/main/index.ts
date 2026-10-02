import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { dirname, join } from 'node:path';
import { ClaudeCliClient } from '../analyze/llm.js';
import { currentStatus } from '../analyze/runner.js';
import { loadConfig } from '../config.js';
import { readLiveSessions } from '../ingest/live.js';
import { openDb } from '../store/db.js';
import type { NewSessionRequest } from '../shared/api.js';
import { resolveShellPath, sessionEnv } from './env.js';
import { CompanionService } from './service.js';

const TICK_MS = 5000;
const TICK_WHILE_ANALYZING_MS = 1500;

// A separate app-data folder lets a test instance run next to your everyday one.
if (process.env.COMPANION_USER_DATA) app.setPath('userData', process.env.COMPANION_USER_DATA);
// `companion` run twice focuses the existing window instead of opening a second app.
if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;

app.whenReady().then(() => {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const shellPath = resolveShellPath();
  const send = (channel: string, ...args: unknown[]) => win?.webContents.send(channel, ...args);

  const service = new CompanionService({
    db,
    cfg,
    llm: new ClaudeCliClient(db, join(dirname(cfg.dbPath), 'run')),
    loadLive: () => readLiveSessions(cfg.claudeDir),
    env: () => sessionEnv(shellPath),
    analysis: !process.env.COMPANION_NO_ANALYSIS,
    onItems: (id, items) => send('session:items', id, items),
    onState: (state) => send('session:state', state),
    onData: (id, data, end) => send('term:data', id, data, end),
    onSent: (id, itemId) => send('session:sent', id, itemId),
    onChanged: () => send('changed'),
  });

  ipcMain.handle('sessions:list', (_e, q) => service.listSessions(q ?? {}));
  ipcMain.handle('projects:list', () => service.listProjects());
  ipcMain.handle('recap:get', () => service.getRecap());
  ipcMain.handle('recap:regenerate', () => {
    void service.analyze({ force: true });
  });
  ipcMain.handle('session:open', (_e, id: string) => service.openSession(id));
  ipcMain.on('session:close', (_e, id: string) => service.closeSessionView(id));
  ipcMain.handle('session:new', (_e, req: NewSessionRequest) => service.newSession(req));
  ipcMain.handle('session:send', (_e, id: string, text: string) => service.send(id, text));
  ipcMain.on('session:answer', (_e, id: string, key: string) => service.answer(id, key));
  ipcMain.on('session:interrupt', (_e, id: string) => service.interrupt(id));
  ipcMain.on('session:cycleMode', (_e, id: string) => service.cyclePermissionMode(id));
  ipcMain.handle('session:stop', (_e, id: string) => service.stop(id));
  ipcMain.handle('session:openInTerminal', (_e, id: string) => service.openInTerminal(id));
  ipcMain.handle('term:replay', (_e, id: string) => service.replay(id));
  ipcMain.on('term:write', (_e, id: string, data: string) => service.write(id, data));
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => service.resize(id, cols, rows));
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

  // Sessions are Claude Code background sessions: quitting only detaches, and they keep running.
  app.on('before-quit', () => service.disposeAll());
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
