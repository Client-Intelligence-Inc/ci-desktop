import { dialog, ipcMain, IpcMainInvokeEvent } from 'electron';
import { DesktopAgentService } from './service';
import {
  DesktopAgentSettings,
  LocalDesktopJobInput,
  MacPermissionName,
  PairPersonalDeviceInput,
  PromptResponse,
} from './types';
import { isMacPermissionName } from './permissions';

type OriginChecker = (url?: string) => boolean;
type AgentControlCenterOpener = () => void;

export function initAgentIpc(
  agent: DesktopAgentService,
  isTrustedOrigin: OriginChecker,
  openAgentControlCenter?: AgentControlCenterOpener,
): void {
  ipcMain.handle('agent:get-status', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.getStatus();
  });

  ipcMain.handle('agent:get-capabilities', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.getCapabilities();
  });

  ipcMain.handle('agent:get-setup-checklist', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.getSetupChecklist();
  });

  ipcMain.handle('agent:connect', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    agent.connect();
    return agent.getStatus();
  });

  ipcMain.handle('agent:disconnect', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    agent.disconnect();
    return agent.getStatus();
  });

  ipcMain.handle('agent:pair-personal-device', (event, input?: string | PairPersonalDeviceInput) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.pairPersonalDevice(input);
  });

  ipcMain.handle('agent:revoke-personal-device', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.revokePersonalDevice();
  });

  ipcMain.handle('agent:update-settings', (event, patch: Partial<DesktopAgentSettings>) => {
    assertTrustedSender(event, isTrustedOrigin);
    agent.updateSettings(patch);
    return agent.getStatus();
  });

  ipcMain.handle('agent:choose-allowed-folder', async (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      message: 'Choose a folder Client Intelligence can access',
    });

    if (result.canceled || !result.filePaths[0]) {
      return agent.getStatus();
    }

    agent.addAllowedFolderFromNativePicker(result.filePaths[0]);

    return agent.getStatus();
  });

  ipcMain.handle('agent:remove-allowed-folder', (event, folder: string) => {
    assertTrustedSender(event, isTrustedOrigin);
    agent.removeAllowedFolder(folder);
    return agent.getStatus();
  });

  ipcMain.handle('agent:clear-allowed-folders', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    agent.clearAllowedFolders();
    return agent.getStatus();
  });

  ipcMain.handle('agent:open-permission-settings', (event, permission: unknown) => {
    assertTrustedSender(event, isTrustedOrigin);
    if (!isMacPermissionName(permission)) {
      throw new Error('Unsupported macOS permission shortcut');
    }
    agent.openPermissionSettings(permission);
    return true;
  });

  ipcMain.handle('agent:open-control-center', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    if (!openAgentControlCenter) {
      throw new Error('Agent Control Center is not available');
    }
    openAgentControlCenter();
    return true;
  });

  ipcMain.handle('agent:run-local-tool', (event, tool: string, args: unknown) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.runLocalTool(tool, args);
  });

  ipcMain.handle('agent:run-local-desktop-job', (event, input: LocalDesktopJobInput) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.runLocalDesktopJob(input);
  });

  ipcMain.handle('agent:get-local-desktop-jobs', (event, limit?: number) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.getLocalDesktopJobs(limit);
  });

  ipcMain.handle('agent:get-local-desktop-job', (event, jobId: string) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.getLocalDesktopJob(jobId);
  });

  ipcMain.handle(
    'agent:respond-to-local-desktop-prompt',
    (event, jobId: string, promptId: string, response: PromptResponse) => {
      assertTrustedSender(event, isTrustedOrigin);
      return agent.respondToLocalDesktopPrompt(jobId, promptId, response);
    },
  );

  ipcMain.handle('agent:cancel-local-desktop-job', (event, jobId: string) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.cancelLocalDesktopJob(jobId);
  });

  ipcMain.handle('agent:get-audit', (event, limit?: number) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.readAuditEntries(limit);
  });

  ipcMain.handle('agent:get-audit-info', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.getAuditInfo();
  });

  ipcMain.handle('agent:get-support-bundle', (event, limit?: number) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.getSupportBundle(limit);
  });

  ipcMain.handle('agent:clear-audit', (event) => {
    assertTrustedSender(event, isTrustedOrigin);
    return agent.clearAuditEntries();
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent, isTrustedOrigin: OriginChecker): void {
  const url = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedOrigin(url)) {
    throw new Error('Untrusted sender origin');
  }
}
