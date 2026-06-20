import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync('get-app-version') as string,
  isDesktopApp: true,
});

contextBridge.exposeInMainWorld('clientIntelligenceDesktop', {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync('get-app-version') as string,
  isDesktopApp: true,
  agent: {
    getStatus: () => ipcRenderer.invoke('agent:get-status'),
    getCapabilities: () => ipcRenderer.invoke('agent:get-capabilities'),
    getSetupChecklist: () => ipcRenderer.invoke('agent:get-setup-checklist'),
    connect: () => ipcRenderer.invoke('agent:connect'),
    disconnect: () => ipcRenderer.invoke('agent:disconnect'),
    pairPersonalDevice: (
      ownerUserIdOrInput?: string | { ownerUserId?: string; pairingToken?: string },
      pairingToken?: string,
    ) => ipcRenderer.invoke(
      'agent:pair-personal-device',
      pairingToken && typeof ownerUserIdOrInput === 'string'
        ? { ownerUserId: ownerUserIdOrInput, pairingToken }
        : ownerUserIdOrInput,
    ),
    revokePersonalDevice: () => ipcRenderer.invoke('agent:revoke-personal-device'),
    updateSettings: (patch: unknown) => ipcRenderer.invoke('agent:update-settings', patch),
    chooseAllowedFolder: () => ipcRenderer.invoke('agent:choose-allowed-folder'),
    removeAllowedFolder: (folder: string) => ipcRenderer.invoke('agent:remove-allowed-folder', folder),
    clearAllowedFolders: () => ipcRenderer.invoke('agent:clear-allowed-folders'),
    openPermissionSettings: (permission: string) => (
      ipcRenderer.invoke('agent:open-permission-settings', permission)
    ),
    runLocalTool: (tool: string, args: unknown) => ipcRenderer.invoke('agent:run-local-tool', tool, args),
    getAudit: (limit?: number) => ipcRenderer.invoke('agent:get-audit', limit),
    getAuditInfo: () => ipcRenderer.invoke('agent:get-audit-info'),
    clearAudit: () => ipcRenderer.invoke('agent:clear-audit'),
  },
});
