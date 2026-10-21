import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { dirname, join } from 'node:path';
import { ClaudeCliClient } from '../analyze/llm.js';
import { currentStatus } from '../analyze/runner.js';
import { loadConfig } from '../config.js';
import { readLiveSessions } from '../ingest/live.js';
import { socketPath } from '../mcp/protocol.js';
import { openDb } from '../store/db.js';
import type { NewSessionRequest } from '../shared/api.js';
import { listenForSessions } from './app-socket.js';
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
    loadLive: () => readLiveSessions(cfg.claudeDir).filter((l) => !cfg.isOptedOut(l.cwd)),
    env: () => sessionEnv(shellPath),
    analysis: !process.env.COMPANION_NO_ANALYSIS,
    notes: !process.env.COMPANION_NO_NOTES,
    notesDelayMs: process.env.COMPANION_NOTES_DELAY_MS ? Number(process.env.COMPANION_NOTES_DELAY_MS) : undefined,
    // Companion's MCP server runs from the built CLI on Electron's Node, inside each session it starts.
    mcp: {
      command: process.execPath,
      args: [join(app.getAppPath(), 'dist', 'cli.js'), 'mcp'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        COMPANION_SOCKET: socketPath(cfg),
        ...(process.env.COMPANION_CONFIG ? { COMPANION_CONFIG: process.env.COMPANION_CONFIG } : {}),
        ...(process.env.COMPANION_DB ? { COMPANION_DB: process.env.COMPANION_DB } : {}),
      },
    },
    onNavigate: (id, draft) => {
      win?.show();
      send('navigate', id, draft);
    },
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
  ipcMain.handle('session:setHidden', (_e, ids: string[], hidden: boolean) => service.setHidden(ids, hidden));
  ipcMain.handle('session:delete', async (_e, ids: string[]) => {
    const picked = service.listSessions({}).filter((x) => ids.includes(x.id));
    const running = picked.some((s) => s.live || s.attached);
    const what = ids.length === 1 ? `"${picked[0]?.title ?? 'this chat'}"` : `${ids.length} chats`;
    const r = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: `Delete ${what}?`,
      detail: `${running ? 'Running chats will be stopped. ' : ''}${ids.length === 1 ? 'Its transcript is' : 'Their transcripts are'} deleted from ~/.claude/projects and can't be continued. Chats opened from ${ids.length === 1 ? 'it' : 'them'} are kept.`,
      buttons: [running ? 'Stop and Delete' : 'Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response !== 0) return { ok: true, value: false };
    const done = await service.deleteSessions(ids);
    return done.ok ? { ok: true, value: true } : done;
  });
  ipcMain.handle('term:replay', (_e, id: string) => service.replay(id));
  ipcMain.on('term:write', (_e, id: string, data: string) => service.write(id, data));
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => service.resize(id, cols, rows));
  ipcMain.handle('session:restartWithTools', (_e, id: string) => service.restartWithTools(id));
  ipcMain.handle('tools:install', () => service.installToolsEverywhere());
  ipcMain.handle('session:extras', (_e, id: string) => service.extras(id));
  ipcMain.handle('session:compact', (_e, id: string, focus: string) => service.compact(id, focus));
  ipcMain.handle('session:handOff', (_e, id: string) => service.handOff(id));
  ipcMain.handle('session:pin', (_e, id: string, path: string) => service.pinFile(id, path));
  ipcMain.handle('session:unpin', (_e, id: string, path: string) => service.unpinFile(id, path));
  ipcMain.handle('session:reloadPins', (_e, id: string) => service.reloadPins(id));
  ipcMain.handle('session:refreshNotes', (_e, id: string) => service.refreshNotes(id));
  ipcMain.handle('session:openNotes', async (_e, id: string) => {
    const path = service.notesPath(id);
    if (path) await shell.openPath(path);
  });
  ipcMain.handle('dialog:pickFile', async (_e, id: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], defaultPath: service.cwdOf(id) ?? undefined });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // Claude calling the new-chat tool reaches us here, through Companion's MCP server.
  listenForSessions(socketPath(cfg), (req) => service.handleSocket(req));

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
