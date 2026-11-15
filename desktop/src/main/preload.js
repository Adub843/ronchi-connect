'use strict';
/**
 * The only bridge between the window and the main process. The window sees
 * this as `window.ronchi`. Keep it small: every function here is something
 * the page is trusted to ask for.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (callback) => {
  const handler = (event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('ronchi', {
  info: invoke('app:info'),
  settings: {
    setServerUrl: invoke('settings:setServerUrl'),
    getToken: invoke('settings:getToken'),
    setToken: invoke('settings:setToken'),
  },
  host: {
    displays: invoke('host:displays'),
    setSession: invoke('host:setSession'),
    sendInput: (event) => ipcRenderer.send('host:input', event),
    onEndRequested: listen('host:endRequested'),
    onToggleControlRequested: listen('host:toggleControlRequested'),
  },
  tech: {
    setSignedIn: invoke('tech:setSignedIn'),
  },
  window: {
    attention: invoke('window:attention'),
    setFullScreen: invoke('window:setFullScreen'),
  },
  clipboard: {
    read: invoke('clipboard:read'),
    write: invoke('clipboard:write'),
  },
  files: {
    pick: invoke('files:pick'),
    read: invoke('files:read'),
    release: invoke('files:release'),
    begin: invoke('files:begin'),
    append: invoke('files:append'),
    finish: invoke('files:finish'),
    cancel: invoke('files:cancel'),
    saveImage: invoke('files:saveImage'),
    openFolder: invoke('files:openFolder'),
  },
});
