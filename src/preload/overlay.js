'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onDeliver: cb => ipcRenderer.on('overlay:deliver', (_e, d) => cb(d)),
  onAbort: cb => ipcRenderer.on('overlay:abort', () => cb()),
  onGeometry: cb => ipcRenderer.on('overlay:geometry', (_e, g) => cb(g)),
  send: ev => ipcRenderer.send('overlay:event', ev)
});
