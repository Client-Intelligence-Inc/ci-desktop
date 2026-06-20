import { shell, systemPreferences } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MacPermissionName, PermissionStatus } from './types';

const execFileAsync = promisify(execFile);
const PERMISSION_SETTINGS_PANES: Record<MacPermissionName, string> = {
  full_disk_access: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

export async function getPermissionStatuses(): Promise<PermissionStatus[]> {
  const accessibility = process.platform === 'darwin' && systemPreferences?.isTrustedAccessibilityClient
    ? systemPreferences.isTrustedAccessibilityClient(false)
    : false;

  const screen = process.platform === 'darwin' && systemPreferences?.getMediaAccessStatus
    ? systemPreferences.getMediaAccessStatus('screen')
    : 'unknown';

  return [
    {
      name: 'full_disk_access',
      status: await canReadProtectedMacPath() ? 'granted' : 'unknown',
      detail: 'macOS does not expose a definitive Full Disk Access check to Electron.',
    },
    {
      name: 'accessibility',
      status: accessibility ? 'granted' : 'not_determined',
    },
    {
      name: 'screen_recording',
      status: normalizeMediaStatus(screen),
    },
    {
      name: 'automation',
      status: 'unknown',
      detail: 'Automation approval is granted per target app when Apple Events are first used.',
    },
  ];
}

export function openPermissionSettings(permission: MacPermissionName): void {
  if (!isMacPermissionName(permission)) {
    throw new Error(`Unsupported macOS permission shortcut: ${String(permission)}`);
  }

  shell.openExternal(PERMISSION_SETTINGS_PANES[permission]);
}

export function isMacPermissionName(permission: unknown): permission is MacPermissionName {
  return typeof permission === 'string' && permission in PERMISSION_SETTINGS_PANES;
}

async function canReadProtectedMacPath(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;

  try {
    await execFileAsync('/bin/ls', [`${process.env.HOME || ''}/Library/Mail`], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function normalizeMediaStatus(status: string): PermissionStatus['status'] {
  switch (status) {
    case 'granted':
      return 'granted';
    case 'denied':
    case 'restricted':
      return 'denied';
    case 'not-determined':
      return 'not_determined';
    default:
      return 'unknown';
  }
}
