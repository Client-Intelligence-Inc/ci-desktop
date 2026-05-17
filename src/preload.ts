import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync('get-app-version') as string,
  isDesktopApp: true,
});
