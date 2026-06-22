import { app, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';

export type UpdateChannel = 'stable' | 'beta';

function getChannelSettingsPath(): string {
  return path.join(app.getPath('userData'), 'update-channel.json');
}

export function loadUpdateChannel(): UpdateChannel {
  try {
    const data = JSON.parse(fs.readFileSync(getChannelSettingsPath(), 'utf-8'));
    if (data.channel === 'beta') return 'beta';
  } catch {
    // default
  }
  return 'stable';
}

export function saveUpdateChannel(channel: UpdateChannel): void {
  try {
    fs.mkdirSync(path.dirname(getChannelSettingsPath()), { recursive: true });
    fs.writeFileSync(getChannelSettingsPath(), JSON.stringify({ channel }));
  } catch {
    // best-effort
  }
}

export function applyUpdateChannel(channel: UpdateChannel): void {
  autoUpdater.allowPrerelease = channel === 'beta';
  autoUpdater.channel = channel;
}

export function initUpdateChannelIpc(): void {
  ipcMain.handle('update-channel:get', () => {
    return loadUpdateChannel();
  });

  ipcMain.handle('update-channel:set', (_event, channel: string) => {
    if (channel !== 'stable' && channel !== 'beta') {
      throw new Error('Invalid update channel');
    }
    saveUpdateChannel(channel);
    applyUpdateChannel(channel);
    return channel;
  });
}
