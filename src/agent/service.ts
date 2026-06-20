import { app } from 'electron';
import { randomBytes, randomUUID } from 'crypto';
import { AgentConnection } from './connection';
import { pairDeviceWithGateway, revokeDeviceWithGateway } from './pairing';
import { getPermissionStatuses, openPermissionSettings } from './permissions';
import {
  loadAgentSettings,
  loadLegacyDeviceTokenFromSettingsFile,
  saveAgentSettings,
  updateAgentSettings,
} from './settings';
import { appendAuditEntry, clearAuditEntries, getAuditInfo, readAuditEntries } from './audit';
import { getCapability, getCapabilityManifest, runCapability } from './capabilities';
import { deriveJobSigningSecret } from './job-signing';
import { deleteDeviceToken, loadDeviceToken, saveDeviceToken } from './keychain';
import { isAllowedGatewayURL } from './origin';
import {
  AgentStatus,
  AuditEntry,
  AuditInfo,
  DesktopAgentSettings,
  MacPermissionName,
  PairPersonalDeviceInput,
  SetupChecklist,
  SetupChecklistItem,
  ToolResult,
} from './types';

export class DesktopAgentService {
  private settings = loadAgentSettings();
  private readonly connection = new AgentConnection(
    () => this.settings,
    (patch) => {
      this.settings = updateAgentSettings(patch);
      return this.settings;
    },
  );

  constructor() {
    this.connection.onStatusChange(() => undefined);
  }

  onStatusChange(listener: () => void): () => void {
    return this.connection.onStatusChange(listener);
  }

  start(): void {
    this.applyLaunchAtLogin();
    if (this.settings.enabled) {
      void this.connectWithStoredToken();
    }

    app.on('browser-window-focus', () => {
      if (this.settings.enabled && this.connection.getSnapshot().connection === 'disconnected') {
        void this.connectWithStoredToken();
      }
    });

    powerMonitorSafe(
      () => {
        if (this.settings.enabled) {
          void this.reconnectAfterWake();
        }
      },
      () => {
        if (this.settings.enabled) {
          this.connection.pauseForSleep();
        }
      },
    );
  }

  connect(): void {
    this.settings = updateAgentSettings({ enabled: true });
    this.applyLaunchAtLogin();
    void this.connectWithStoredToken();
  }

  disconnect(): void {
    this.settings = updateAgentSettings({ enabled: false });
    this.connection.disconnect();
  }

  async pairPersonalDevice(input: string | PairPersonalDeviceInput = 'josh-local'): Promise<AgentStatus> {
    const pairInput = normalizePairPersonalDeviceInput(input);
    let pairResult: {
      deviceId: string;
      deviceToken: string;
      ownerUserId: string;
    };

    try {
      pairResult = await pairDeviceWithGateway(this.settings.gatewayUrl, {
        ownerUserId: pairInput.ownerUserId,
        displayName: this.settings.displayName,
        existingDeviceId: this.settings.deviceId,
        capabilities: { tools: getCapabilityManifest() },
        pairingToken: pairInput.pairingToken,
      });
    } catch (error) {
      if (!allowOfflinePairingFallback()) {
        appendAuditEntry({
          deviceId: this.settings.deviceId,
          tool: 'desktop.pair',
          action: 'pair.gateway',
          result: 'denied',
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(`Desktop pairing failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      pairResult = {
        deviceId: this.settings.deviceId || `dev_${randomUUID()}`,
        deviceToken: `ci_desktop_${randomBytes(32).toString('hex')}`,
        ownerUserId: pairInput.ownerUserId,
      };
    }

    try {
      await saveDeviceToken(pairResult.deviceId, pairResult.deviceToken);
    } catch (error) {
      await revokeDeviceWithGateway(this.settings.gatewayUrl, pairResult.deviceId, pairResult.deviceToken).catch(() => undefined);
      appendAuditEntry({
        deviceId: pairResult.deviceId,
        tool: 'desktop.pair',
        action: 'pair.keychain',
        result: 'denied',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Desktop pairing failed: device token could not be saved to Keychain (${error instanceof Error ? error.message : String(error)})`);
    }

    const persistedSettings = updateAgentSettings({
      deviceId: pairResult.deviceId,
      ownerUserId: pairResult.ownerUserId,
      enabled: true,
      deviceApprovalGrants: [],
    });
    this.settings = {
      ...persistedSettings,
      deviceToken: pairResult.deviceToken,
      jobSigningSecret: deriveJobSigningSecret(pairResult.deviceToken),
    };

    this.connection.clearAuthorizationState();
    this.connection.reconnectNow('desktop_agent_pairing_changed');
    return this.getStatus();
  }

  async revokePersonalDevice(): Promise<AgentStatus> {
    const deviceId = this.settings.deviceId;
    const deviceToken = await this.getDeviceToken();
    this.connection.disconnect();

    if (deviceId) {
      await revokeDeviceWithGateway(this.settings.gatewayUrl, deviceId, deviceToken).catch(() => undefined);
    }

    if (deviceId) {
      await deleteDeviceToken(deviceId).catch(() => undefined);
    }

    this.settings = updateAgentSettings({
      enabled: false,
      deviceId: undefined,
      ownerUserId: undefined,
      deviceApprovalGrants: [],
    });
    this.connection.clearAuthorizationState();

    return this.getStatus();
  }

  async getStatus(): Promise<AgentStatus> {
    const snapshot = this.connection.getSnapshot();

    return {
      connection: this.settings.enabled ? snapshot.connection : 'disabled',
      enabled: this.settings.enabled,
      launchAtLogin: this.settings.launchAtLogin,
      deviceId: this.settings.deviceId,
      displayName: this.settings.displayName,
      gatewayUrl: this.settings.gatewayUrl,
      ownerUserId: this.settings.ownerUserId,
      fileAccessMode: this.settings.fileAccessMode,
      allowedFolders: this.settings.allowedFolders,
      controlMode: this.settings.controlMode,
      approvalMode: this.settings.approvalMode,
      allowShell: this.settings.allowShell,
      permissions: await getPermissionStatuses(),
      lastError: snapshot.lastError,
      lastConnectedAt: snapshot.lastConnectedAt,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      reconnectAttempt: snapshot.reconnectAttempt,
      nextReconnectAt: snapshot.nextReconnectAt,
      nextReconnectDelayMs: snapshot.nextReconnectDelayMs,
      activeJobIds: snapshot.activeJobIds,
      activeJobs: snapshot.activeJobs,
      capabilities: getCapabilityManifest(),
    };
  }

  getCapabilities() {
    return getCapabilityManifest();
  }

  async getSetupChecklist(): Promise<SetupChecklist> {
    const status = await this.getStatus();
    const permissions = new Map(status.permissions.map((permission) => [permission.name, permission.status]));
    const isPaired = Boolean(status.deviceId && status.ownerUserId);
    const selectedFoldersReady = status.fileAccessMode === 'selected_folders' && status.allowedFolders.length > 0;
    const fullDiskReady = (
      status.fileAccessMode === 'full_disk' &&
      permissions.get('full_disk_access') === 'granted'
    );
    const fileScopeReady = selectedFoldersReady || fullDiskReady;
    const screenModeEnabled = controlModeAtLeast(status.controlMode, 'screen');
    const inputModeEnabled = controlModeAtLeast(status.controlMode, 'keyboard_mouse');
    const automationModeEnabled = controlModeAtLeast(status.controlMode, 'automation');
    const accessibilityReady = permissions.get('accessibility') === 'granted';
    const screenReady = permissions.get('screen_recording') === 'granted';

    const items: SetupChecklistItem[] = [
      {
        id: 'personal_device',
        label: 'Personal desktop pairing',
        status: isPaired ? 'ready' : 'needs_action',
        required: true,
        detail: isPaired
          ? `Paired as ${status.displayName} for ${status.ownerUserId}`
          : 'Pair this Mac to your personal Client Intelligence account.',
        action: isPaired ? undefined : 'pair_personal_device',
      },
      {
        id: 'agent_enabled',
        label: 'Desktop agent enabled',
        status: status.enabled ? 'ready' : 'needs_action',
        required: true,
        detail: status.enabled
          ? 'The desktop agent is allowed to maintain a gateway connection.'
          : 'Enable the desktop agent before sending remote jobs.',
        action: status.enabled ? undefined : 'connect_agent',
      },
      {
        id: 'gateway_connection',
        label: 'Gateway connection',
        status: status.connection === 'connected'
          ? 'ready'
          : status.enabled
            ? 'needs_action'
            : 'disabled',
        required: true,
        detail: status.connection === 'connected'
          ? `Connected to ${status.gatewayUrl}`
          : status.lastError || `Current connection state: ${status.connection}`,
        action: status.connection === 'connected' ? undefined : 'connect_agent',
      },
      {
        id: 'launch_at_login',
        label: 'Launch at login',
        status: status.launchAtLogin ? 'ready' : 'needs_action',
        required: true,
        detail: status.launchAtLogin
          ? 'Client Intelligence Desktop will start automatically when this Mac signs in.'
          : 'Enable launch at login so this Mac is reachable after restart.',
        action: status.launchAtLogin ? undefined : 'enable_launch_at_login',
      },
      {
        id: 'file_scope',
        label: 'File access scope',
        status: fileScopeReady ? 'ready' : 'needs_action',
        required: true,
        detail: fileScopeDetail(status.fileAccessMode, status.allowedFolders.length, permissions.get('full_disk_access')),
        action: fileScopeReady
          ? undefined
          : status.fileAccessMode === 'full_disk'
            ? 'open_full_disk_settings'
            : 'choose_allowed_folder',
      },
      {
        id: 'screen_view',
        label: 'Screen screenshots and streaming',
        status: readinessForFeature(screenModeEnabled, screenReady),
        required: false,
        detail: screenModeEnabled
          ? permissionDetail('Screen Recording', screenReady)
          : 'Enable screen control mode before requesting screenshots or streams.',
        action: screenModeEnabled && !screenReady ? 'open_screen_recording_settings' : undefined,
      },
      {
        id: 'keyboard_mouse',
        label: 'Keyboard and mouse control',
        status: readinessForFeature(inputModeEnabled, accessibilityReady),
        required: false,
        detail: inputModeEnabled
          ? permissionDetail('Accessibility', accessibilityReady)
          : 'Enable keyboard/mouse control mode before sending input jobs.',
        action: inputModeEnabled && !accessibilityReady ? 'open_accessibility_settings' : undefined,
      },
      {
        id: 'app_automation',
        label: 'App automation',
        status: automationModeEnabled
          ? accessibilityReady ? 'unknown' : 'needs_action'
          : 'disabled',
        required: false,
        detail: automationModeEnabled
          ? accessibilityReady
            ? 'Automation approval is granted per target app when Apple Events are first used.'
            : 'Accessibility is required before app automation can run reliably.'
          : 'Enable automation control mode before running AppleScript jobs.',
        action: automationModeEnabled && !accessibilityReady ? 'open_accessibility_settings' : undefined,
      },
      {
        id: 'shell_commands',
        label: 'Shell commands',
        status: status.allowShell ? 'ready' : 'disabled',
        required: false,
        detail: status.allowShell
          ? 'Guarded shell commands are enabled and still require high-risk approval.'
          : 'Shell commands are disabled for this desktop agent.',
        action: status.allowShell ? undefined : 'enable_shell',
      },
    ];

    return {
      ready: items.filter((item) => item.required).every((item) => item.status === 'ready'),
      generatedAt: new Date().toISOString(),
      items,
    };
  }

  updateSettings(patch: Partial<DesktopAgentSettings>): DesktopAgentSettings {
    const sanitized = sanitizeSettingsPatch(patch);
    this.settings = updateAgentSettings(sanitized);
    this.applyLaunchAtLogin();

    if (this.settings.enabled) {
      void this.connectWithStoredToken();
    } else {
      this.connection.disconnect();
    }

    return this.settings;
  }

  removeAllowedFolder(folder: string): DesktopAgentSettings {
    const normalized = String(folder || '');
    this.settings = updateAgentSettings({
      allowedFolders: this.settings.allowedFolders.filter((candidate) => candidate !== normalized),
    });
    return this.settings;
  }

  addAllowedFolderFromNativePicker(folder: string): DesktopAgentSettings {
    const normalized = String(folder || '').trim();
    if (!normalized) return this.settings;

    const folders = new Set(this.settings.allowedFolders);
    folders.add(normalized);
    this.settings = updateAgentSettings({
      fileAccessMode: 'selected_folders',
      allowedFolders: [...folders],
    });
    return this.settings;
  }

  clearAllowedFolders(): DesktopAgentSettings {
    this.settings = updateAgentSettings({
      fileAccessMode: 'selected_folders',
      allowedFolders: [],
    });
    return this.settings;
  }

  openPermissionSettings(permission: MacPermissionName): void {
    openPermissionSettings(permission);
  }

  readAuditEntries(limit?: unknown): AuditEntry[] {
    return readAuditEntries(limit);
  }

  getAuditInfo(): AuditInfo {
    return getAuditInfo();
  }

  clearAuditEntries(): AuditInfo {
    clearAuditEntries();
    return getAuditInfo();
  }

  async runLocalTool(tool: string, args: unknown): Promise<ToolResult> {
    const capability = getCapability(tool);
    if (capability?.requiresApproval) {
      appendAuditEntry({
        deviceId: this.settings.deviceId,
        jobId: `local_${Date.now()}`,
        tool,
        action: 'local_tool.dispatch',
        result: 'denied',
        error: 'Approval-required capability cannot run through trusted bridge',
      });
      return {
        ok: false,
        error: 'Approval-required capability cannot run through trusted bridge; send it as a desktop job so approval can be requested.',
      };
    }

    return runCapability({
      jobId: `local_${Date.now()}`,
      tool,
      args,
    }, this.settings);
  }

  private applyLaunchAtLogin(): void {
    if (!app?.setLoginItemSettings) {
      return;
    }

    if (!app.isPackaged && process.platform === 'darwin') {
      return;
    }

    app.setLoginItemSettings({
      openAtLogin: this.settings.launchAtLogin,
      openAsHidden: true,
    });
  }

  private async connectWithStoredToken(): Promise<void> {
    await this.hydrateDeviceToken();
    this.connection.connect();
  }

  private async reconnectAfterWake(): Promise<void> {
    await this.hydrateDeviceToken();
    this.connection.reconnectNow('desktop_agent_wake_reconnect');
  }

  private async hydrateDeviceToken(): Promise<void> {
    const token = await this.getDeviceToken();
    if (token) {
      this.settings = {
        ...this.settings,
        deviceToken: token,
        jobSigningSecret: deriveJobSigningSecret(token),
      };
    }
  }

  private async getDeviceToken(): Promise<string | undefined> {
    if (!this.settings.deviceId) return this.settings.deviceToken;
    if (this.settings.deviceToken) return this.settings.deviceToken;

    const keychainToken = await loadDeviceToken(this.settings.deviceId).catch(() => undefined);
    if (keychainToken) return keychainToken;

    const legacyToken = loadLegacyDeviceTokenFromSettingsFile();
    if (legacyToken) {
      try {
        await saveDeviceToken(this.settings.deviceId, legacyToken);
      } catch (error) {
        appendAuditEntry({
          deviceId: this.settings.deviceId,
          tool: 'desktop.token',
          action: 'token.migrate',
          result: 'denied',
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
      saveAgentSettings(this.settings);
      return legacyToken;
    }

    return undefined;
  }
}

function controlModeAtLeast(
  actual: DesktopAgentSettings['controlMode'],
  required: DesktopAgentSettings['controlMode'],
): boolean {
  const order: DesktopAgentSettings['controlMode'][] = [
    'disabled',
    'open_apps',
    'screen',
    'keyboard_mouse',
    'automation',
  ];
  return order.indexOf(actual) >= order.indexOf(required);
}

function readinessForFeature(enabled: boolean, permissionReady: boolean): SetupChecklistItem['status'] {
  if (!enabled) return 'disabled';
  return permissionReady ? 'ready' : 'needs_action';
}

function permissionDetail(permission: string, ready: boolean): string {
  return ready
    ? `${permission} permission is granted.`
    : `${permission} permission is required for this capability.`;
}

function fileScopeDetail(
  mode: DesktopAgentSettings['fileAccessMode'],
  folderCount: number,
  fullDiskStatus: string | undefined,
): string {
  if (mode === 'selected_folders') {
    return folderCount > 0
      ? `${folderCount} selected folder${folderCount === 1 ? '' : 's'} available.`
      : 'Choose at least one folder or switch to full-disk mode.';
  }
  if (mode === 'full_disk') {
    return fullDiskStatus === 'granted'
      ? 'Full-disk mode is selected and the permission probe succeeded.'
      : 'Full-disk mode is selected, but macOS Full Disk Access still needs review.';
  }
  return 'File access is disabled. Choose folders or switch to full-disk mode.';
}

function sanitizeSettingsPatch(patch: Partial<DesktopAgentSettings>): Partial<DesktopAgentSettings> {
  const allowed: Partial<DesktopAgentSettings> = {};

  if (typeof patch.displayName === 'string') allowed.displayName = patch.displayName.slice(0, 120);
  if (typeof patch.launchAtLogin === 'boolean') allowed.launchAtLogin = patch.launchAtLogin;
  if (typeof patch.enabled === 'boolean') allowed.enabled = patch.enabled;
  if (typeof patch.gatewayUrl === 'string' && isAllowedGatewayURL(patch.gatewayUrl)) {
    allowed.gatewayUrl = patch.gatewayUrl;
  }
  if (patch.fileAccessMode && ['none', 'selected_folders', 'full_disk'].includes(patch.fileAccessMode)) {
    allowed.fileAccessMode = patch.fileAccessMode;
  }
  if (patch.controlMode && ['disabled', 'open_apps', 'screen', 'keyboard_mouse', 'automation'].includes(patch.controlMode)) {
    allowed.controlMode = patch.controlMode;
  }
  if (patch.approvalMode && ['ask_every_time', 'session', 'device', 'always_for_owner'].includes(patch.approvalMode)) {
    allowed.approvalMode = patch.approvalMode;
  }
  if (typeof patch.allowShell === 'boolean') allowed.allowShell = patch.allowShell;

  return allowed;
}

function allowOfflinePairingFallback(): boolean {
  return process.env.CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING === '1';
}

function normalizePairPersonalDeviceInput(input: string | PairPersonalDeviceInput): Required<Pick<PairPersonalDeviceInput, 'ownerUserId'>> & Pick<PairPersonalDeviceInput, 'pairingToken'> {
  if (typeof input === 'string') {
    return { ownerUserId: normalizePairingField(input, 'ownerUserId') || 'josh-local' };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Pairing input must be an ownerUserId string or an object with string ownerUserId and pairingToken fields');
  }

  return {
    ownerUserId: normalizePairingField(input.ownerUserId, 'ownerUserId') || 'josh-local',
    pairingToken: normalizePairingField(input.pairingToken, 'pairingToken'),
  };
}

function normalizePairingField(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Pairing ${fieldName} must be a string`);
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function powerMonitorSafe(onResume: () => void, onSuspend: () => void): void {
  try {
    // Imported lazily to keep tests and non-Electron contexts simple.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { powerMonitor } = require('electron') as typeof import('electron');
    powerMonitor.on('suspend', onSuspend);
    powerMonitor.on('resume', onResume);
  } catch {
    // ignore
  }
}
