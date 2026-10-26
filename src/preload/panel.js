'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('titli', {
  state: () => ipcRenderer.invoke('panel:state'),
  call: (method, ...args) => ipcRenderer.invoke('panel:call', method, args),
  ui: (action, arg) => ipcRenderer.invoke('panel:ui', action, arg),
  onState: cb => ipcRenderer.on('panel:state', (_e, s) => cb(s)),
  onOpened: cb => ipcRenderer.on('panel:opened', () => cb())
});
