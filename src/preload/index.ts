import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CompanionApi } from '../shared/api.js';

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: CompanionApi = {
  listSessions: (q) => ipcRenderer.invoke('sessions:list', q),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getRecap: () => ipcRenderer.invoke('recap:get'),
  regenerateRecap: () => ipcRenderer.invoke('recap:regenerate'),
  openSession: (id) => ipcRenderer.invoke('session:open', id),
  closeSessionView: (id) => ipcRenderer.send('session:close', id),
  newSession: (req) => ipcRenderer.invoke('session:new', req),
  send: (id, text) => ipcRenderer.invoke('session:send', id, text),
  answer: (id, key) => ipcRenderer.send('session:answer', id, key),
  interrupt: (id) => ipcRenderer.send('session:interrupt', id),
  cyclePermissionMode: (id) => ipcRenderer.send('session:cycleMode', id),
  stop: (id) => ipcRenderer.invoke('session:stop', id),
  openInTerminal: (id) => ipcRenderer.invoke('session:openInTerminal', id),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  getExtras: (id) => ipcRenderer.invoke('session:extras', id),
  compact: (id, focus) => ipcRenderer.invoke('session:compact', id, focus),
  handOff: (id) => ipcRenderer.invoke('session:handOff', id),
  pickFile: (id) => ipcRenderer.invoke('dialog:pickFile', id),
  pinFile: (id, path) => ipcRenderer.invoke('session:pin', id, path),
  unpinFile: (id, path) => ipcRenderer.invoke('session:unpin', id, path),
  reloadPins: (id) => ipcRenderer.invoke('session:reloadPins', id),
  openNotes: (id) => ipcRenderer.invoke('session:openNotes', id),
  refreshNotes: (id) => ipcRenderer.invoke('session:refreshNotes', id),
  restartWithTools: (id) => ipcRenderer.invoke('session:restartWithTools', id),
  installToolsEverywhere: () => ipcRenderer.invoke('tools:install'),
  onNavigate: (cb) => subscribe('navigate', cb),
  replayTerminal: (id) => ipcRenderer.invoke('term:replay', id),
  writeTerminal: (id, data) => ipcRenderer.send('term:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  onItems: (cb) => subscribe('session:items', cb),
  onState: (cb) => subscribe('session:state', cb),
  onTerminalData: (cb) => subscribe('term:data', cb),
  onSentFromApp: (cb) => subscribe('session:sent', cb),
  onChanged: (cb) => subscribe('changed', cb),
};

contextBridge.exposeInMainWorld('companion', api);
