import { autoUpdater } from 'electron-updater';
import { Notification, dialog } from 'electron';

let updateCheckInterval: ReturnType<typeof setInterval> | null = null;

export function initUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    try {
      const notification = new Notification({
        title: 'Client Intelligence',
        body: 'A new version is available. Restart to update.',
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
