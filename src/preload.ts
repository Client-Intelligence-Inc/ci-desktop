import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync('get-app-version') as string,
  isDesktopApp: true,
  navigation: {
    back: () => ipcRenderer.invoke('navigation:back'),
    forward: () => ipcRenderer.invoke('navigation:forward'),
    reload: () => ipcRenderer.invoke('navigation:reload'),
    getState: () => ipcRenderer.invoke('navigation:get-state'),
    onStateChange: (callback: (state: { canGoBack: boolean; canGoForward: boolean }) => void) => {
      const listener = (_event: IpcRendererEvent, state: { canGoBack: boolean; canGoForward: boolean }) => callback(state);
      ipcRenderer.on('navigation:state', listener);
      return () => ipcRenderer.removeListener('navigation:state', listener);
    },
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onEvent: (callback: (data: Record<string, unknown>) => void) => {
      const listener = (_event: IpcRendererEvent, data: Record<string, unknown>) => callback(data);
      ipcRenderer.on('updater:event', listener);
      return () => ipcRenderer.removeListener('updater:event', listener);
    },
  },
});

contextBridge.exposeInMainWorld('clientIntelligenceDesktop', {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync('get-app-version') as string,
  isDesktopApp: true,
  navigation: {
    back: () => ipcRenderer.invoke('navigation:back'),
    forward: () => ipcRenderer.invoke('navigation:forward'),
    reload: () => ipcRenderer.invoke('navigation:reload'),
    getState: () => ipcRenderer.invoke('navigation:get-state'),
    onStateChange: (callback: (state: { canGoBack: boolean; canGoForward: boolean }) => void) => {
      const listener = (_event: IpcRendererEvent, state: { canGoBack: boolean; canGoForward: boolean }) => callback(state);
      ipcRenderer.on('navigation:state', listener);
      return () => ipcRenderer.removeListener('navigation:state', listener);
    },
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onEvent: (callback: (data: Record<string, unknown>) => void) => {
      const listener = (_event: IpcRendererEvent, data: Record<string, unknown>) => callback(data);
      ipcRenderer.on('updater:event', listener);
      return () => ipcRenderer.removeListener('updater:event', listener);
    },
  },
  updateChannel: {
    get: () => ipcRenderer.invoke('update-channel:get'),
    set: (channel: string) => ipcRenderer.invoke('update-channel:set', channel),
  },
  telemetry: {
    isEnabled: () => ipcRenderer.invoke('telemetry:is-enabled'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('telemetry:set-enabled', enabled),
  },
  onboarding: {
    isComplete: () => ipcRenderer.invoke('onboarding:is-complete'),
    complete: () => ipcRenderer.invoke('onboarding:complete'),
  },
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
