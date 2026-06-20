import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DesktopAgentSettings } from './types';
import { normalizeApprovalGrants } from './approvals';

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:47391/desktop-agent/connect';

export function getAgentSettingsPath(): string {
  if (process.env.CI_DESKTOP_AGENT_SETTINGS_PATH) {
    return process.env.CI_DESKTOP_AGENT_SETTINGS_PATH;
  }

  const userDataPath = app?.getPath?.('userData') || path.join(os.tmpdir(), 'client-intelligence-desktop');
  return path.join(userDataPath, 'desktop-agent-settings.json');
}

export function getDefaultAgentSettings(): DesktopAgentSettings {
  return {
    displayName: 'Josh Mac Studio',
    launchAtLogin: false,
    enabled: false,
    gatewayUrl: process.env.CI_DESKTOP_AGENT_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    fileAccessMode: 'selected_folders',
    allowedFolders: [],
    controlMode: 'open_apps',
    approvalMode: 'session',
    allowShell: false,
    deviceApprovalGrants: [],
  };
}

export function loadAgentSettings(): DesktopAgentSettings {
  const defaults = getDefaultAgentSettings();

  try {
    const data = fs.readFileSync(getAgentSettingsPath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<DesktopAgentSettings>;
    const {
      deviceToken: _ignoredDeviceToken,
      jobSigningSecret: _ignoredJobSigningSecret,
      ...persisted
    } = parsed;
    return {
      ...defaults,
      ...persisted,
      allowedFolders: Array.isArray(persisted.allowedFolders) ? persisted.allowedFolders : defaults.allowedFolders,
      deviceApprovalGrants: normalizeApprovalGrants(persisted.deviceApprovalGrants),
    };
  } catch {
    return defaults;
  }
}

export function saveAgentSettings(settings: DesktopAgentSettings): void {
  const settingsPath = getAgentSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(redactPersistedSettings(settings), null, 2));
}

export function updateAgentSettings(patch: Partial<DesktopAgentSettings>): DesktopAgentSettings {
  const next = {
    ...loadAgentSettings(),
    ...patch,
  };
  saveAgentSettings(next);
  return next;
}

export function loadLegacyDeviceTokenFromSettingsFile(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(getAgentSettingsPath(), 'utf-8')) as { deviceToken?: unknown };
    return typeof parsed.deviceToken === 'string' && parsed.deviceToken ? parsed.deviceToken : undefined;
  } catch {
    return undefined;
  }
}

export function redactPersistedSettings(
  settings: DesktopAgentSettings,
): Omit<DesktopAgentSettings, 'deviceToken' | 'jobSigningSecret'> {
  const {
    deviceToken: _deviceToken,
    jobSigningSecret: _jobSigningSecret,
    ...persistable
  } = settings;
  return persistable;
}
