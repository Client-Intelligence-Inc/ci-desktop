import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { BrowserWindow, Notification, app, ipcMain } from 'electron';

let updateCheckInterval: ReturnType<typeof setInterval> | null = null;

export function initUpdater(): void {
  if (process.env.CI_DESKTOP_DISABLE_UPDATES === '1' || !app.isInApplicationsFolder()) {
    console.log('Auto-updater disabled for local desktop build.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    broadcastUpdateEvent('checking-for-update', {});
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log('Update available:', info.version);
    broadcastUpdateEvent('update-available', {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    broadcastUpdateEvent('update-not-available', {});
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    broadcastUpdateEvent('download-progress', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log('Update downloaded:', info.version);
    broadcastUpdateEvent('update-downloaded', { version: info.version });
    try {
      const notification = new Notification({
        title: 'Client Intelligence',
        body: `Version ${info.version} is ready. Restart to update.`,
      });
      notification.on('click', () => {
        autoUpdater.quitAndInstall(false, true);
      });
      notification.show();
    } catch (err) {
      console.error('Failed to show update notification:', err);
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
    broadcastUpdateEvent('error', { message: String(err) });
  });

  ipcMain.handle('updater:check', () => {
    checkForUpdates();
  });

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  setTimeout(() => {
    checkForUpdates();
  }, 10_000);

  updateCheckInterval = setInterval(() => {
    checkForUpdates();
  }, 4 * 60 * 60 * 1000);
}

export function checkForUpdates(): void {
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    console.error('Failed to check for updates:', err);
  }
}

export function cleanup(): void {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}

function broadcastUpdateEvent(event: string, data: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:event', { event, ...data });
    }
  }
}
