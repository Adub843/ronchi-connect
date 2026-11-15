'use strict';
/** Bridge for the small "your screen is being shared" banner window. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('banner', {
  onState: (callback) => ipcRenderer.on('banner:state', (event, state) => callback(state)),
  endSession: () => ipcRenderer.send('banner:end'),
  toggleControl: () => ipcRenderer.send('banner:toggleControl'),
});
