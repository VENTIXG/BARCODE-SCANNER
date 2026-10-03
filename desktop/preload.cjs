/** Small, safe bridge between the web app and Windows (folder picker, open folder). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('imsDesktop', {
  chooseFolder: (current) => ipcRenderer.invoke('ims:choose-folder', current),
  openFolder: (folder) => ipcRenderer.invoke('ims:open-folder', folder),
});
