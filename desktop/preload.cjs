/**
 * Small, safe bridge between the pages and Windows. What a page gets depends on the mode
 * (passed by main.cjs as --ims-mode): the start screen can choose a server, the app gets
 * updates and folder pickers (folders only with this PC's own database).
 */
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = arg('ims-mode');

const updates = {
  status: () => ipcRenderer.invoke('ims:update-status'),
  check: () => ipcRenderer.invoke('ims:update-check'),
  installNow: () => ipcRenderer.invoke('ims:update-install'),
  onChange: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('ims:update-state', handler);
    return () => ipcRenderer.removeListener('ims:update-state', handler);
  },
};

if (mode === 'setup') {
  contextBridge.exposeInMainWorld('imsSetup', {
    appVersion: arg('ims-version'),
    testServer: (url) => ipcRenderer.invoke('ims:test-server', url),
    useServer: (url) => ipcRenderer.invoke('ims:use-server', url),
    useLocal: () => ipcRenderer.invoke('ims:use-local'),
  });
} else {
  contextBridge.exposeInMainWorld('imsDesktop', {
    mode,
    appVersion: arg('ims-version'),
    changeServer: () => ipcRenderer.invoke('ims:change-server'),
    retry: () => ipcRenderer.invoke('ims:retry'),
    updates,
    ...(mode === 'local'
      ? {
          chooseFolder: (current) => ipcRenderer.invoke('ims:choose-folder', current),
          openFolder: (folder) => ipcRenderer.invoke('ims:open-folder', folder),
        }
      : {}),
  });
}
