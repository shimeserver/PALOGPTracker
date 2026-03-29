const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  uploadToStorage: (data) => ipcRenderer.invoke('upload-to-storage', data),
});
