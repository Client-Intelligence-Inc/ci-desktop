import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  shell,
  ipcMain,
  session,
  MenuItemConstructorOptions,
  Tray,
  Notification,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { initUpdater, checkForUpdates } from './updater';
import { initAgentIpc } from './agent/ipc';
import { DesktopAgentService } from './agent/service';
import {
  getURLHost,
  isLocalDevOrigin,
  isTrustedAppURL,
  parseTrustedHosts,
} from './agent/origin';

const DEFAULT_APP_URL = 'https://clientintelligence.ai';
const APP_URL = process.env.CI_DESKTOP_APP_URL || DEFAULT_APP_URL;
const APP_HOST = getURLHost(APP_URL) || 'clientintelligence.ai';
const TRUSTED_APP_HOSTS = new Set([
  APP_HOST,
  `www.${APP_HOST}`,
  ...parseTrustedHosts(process.env.CI_DESKTOP_TRUSTED_HOSTS),
]);
const TRUSTED_OAUTH_HOSTS = new Set([
  'accounts.google.com',
  'github.com',
  'api.notion.com',
  'notion.so',
  'slack.com',
  'zoom.us',
  'login.microsoftonline.com',
  'app.hubspot.com',
]);
const ALLOWED_APP_PERMISSIONS = new Set(['media', 'notifications']);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let desktopAgent: DesktopAgentService | null = null;
let agentTray: Tray | null = null;
let lastNotifiedActiveJobCount: number | undefined;

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  try {
    const data = fs.readFileSync(getWindowStatePath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { width: 1400, height: 900 };
  }
}

function saveWindowState(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: win.isMaximized(),
  };
  try {
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch {
    // ignore write errors
  }
}

function isInternalURL(url: string): boolean {
  return isTrustedAppURL(url, TRUSTED_APP_HOSTS);
}

function isTrustedPermissionOrigin(url?: string): boolean {
  return Boolean(url && isTrustedAppURL(url, TRUSTED_APP_HOSTS));
}

function isTrustedOAuthURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (
      TRUSTED_OAUTH_HOSTS.has(parsed.host) ||
      [...TRUSTED_OAUTH_HOSTS].some((h) => parsed.host.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
}

function configureSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestUrl = details.requestingUrl || webContents.getURL();
    callback(ALLOWED_APP_PERMISSIONS.has(permission) && isTrustedPermissionOrigin(requestUrl));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const requestUrl = requestingOrigin || webContents?.getURL();
    return ALLOWED_APP_PERMISSIONS.has(permission) && isTrustedPermissionOrigin(requestUrl);
  });
}

function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => checkForUpdates(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Desktop Agent',
      submenu: [
        {
          label: 'Connect Agent',
          click: () => desktopAgent?.connect(),
        },
        {
          label: 'Kill Switch: Disconnect Agent',
          click: () => desktopAgent?.disconnect(),
        },
        {
          label: 'Revoke This Device',
          click: () => {
            void desktopAgent?.revokePersonalDevice();
          },
        },
        { type: 'separator' },
        {
          label: 'Open Full Disk Access Settings',
          click: () => desktopAgent?.openPermissionSettings('full_disk_access'),
        },
        {
          label: 'Open Accessibility Settings',
          click: () => desktopAgent?.openPermissionSettings('accessibility'),
        },
        {
          label: 'Open Screen Recording Settings',
          click: () => desktopAgent?.openPermissionSettings('screen_recording'),
        },
        {
          label: 'Open Automation Settings',
          click: () => desktopAgent?.openPermissionSettings('automation'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createAgentTray(): void {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  icon.setTemplateImage(true);

  agentTray = new Tray(icon);
  agentTray.setToolTip('Client Intelligence Desktop Agent');
  agentTray.on('click', () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  desktopAgent?.onStatusChange(() => {
    void updateAgentTray();
  });
  void updateAgentTray();
}

async function updateAgentTray(): Promise<void> {
  if (!agentTray || !desktopAgent) return;

  const status = await desktopAgent.getStatus();
  const activeJobs = status.activeJobIds.length;
  const connectionLabel = status.enabled ? status.connection : 'disabled';
  const activeTool = status.activeJobs[0]?.tool;
  const detail = activeJobs === 1
    ? `1 active job${activeTool ? `: ${activeTool}` : ''}`
    : `${activeJobs} active jobs`;
  notifyRemoteControlState(activeJobs);

  agentTray.setToolTip(`Client Intelligence Desktop Agent: ${connectionLabel}; ${detail}`);
  agentTray.setContextMenu(Menu.buildFromTemplate([
    {
      label: `Agent: ${connectionLabel}`,
      enabled: false,
    },
    {
      label: detail,
      enabled: false,
    },
    {
      label: activeJobs > 0 ? 'Remote control active' : 'Remote control idle',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Client Intelligence',
      click: () => {
        if (!mainWindow) {
          createWindow();
          return;
        }
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: status.enabled ? 'Kill Switch: Disconnect Agent' : 'Connect Agent',
      click: () => {
        if (status.enabled) {
          desktopAgent?.disconnect();
        } else {
          desktopAgent?.connect();
        }
      },
    },
    {
      label: 'Revoke This Device',
      enabled: Boolean(status.deviceId),
      click: () => {
        void desktopAgent?.revokePersonalDevice();
      },
    },
    { type: 'separator' },
    {
      label: 'Open Full Disk Access Settings',
      click: () => desktopAgent?.openPermissionSettings('full_disk_access'),
    },
    {
      label: 'Open Accessibility Settings',
      click: () => desktopAgent?.openPermissionSettings('accessibility'),
    },
    {
      label: 'Open Screen Recording Settings',
      click: () => desktopAgent?.openPermissionSettings('screen_recording'),
    },
    {
      label: 'Open Automation Settings',
      click: () => desktopAgent?.openPermissionSettings('automation'),
    },
  ]));
}

function notifyRemoteControlState(activeJobs: number): void {
  if (lastNotifiedActiveJobCount === undefined) {
    lastNotifiedActiveJobCount = activeJobs;
    return;
  }

  const wasActive = lastNotifiedActiveJobCount > 0;
  const isActive = activeJobs > 0;
  lastNotifiedActiveJobCount = activeJobs;

  if (wasActive === isActive || !Notification.isSupported()) return;

  const notification = new Notification({
    title: isActive
      ? 'Client Intelligence remote control active'
      : 'Client Intelligence remote control idle',
    body: isActive
      ? `${activeJobs} remote desktop job${activeJobs === 1 ? '' : 's'} running. Use the tray kill switch to stop control.`
      : 'No remote desktop jobs are running.',
    silent: false,
  });

  notification.show();
}

function createWindow(): void {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 8 },
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.meta && input.type === 'keyDown') {
      switch (input.key.toLowerCase()) {
        case 'c':
          mainWindow?.webContents.copy()
          break
        case 'x':
          mainWindow?.webContents.cut()
          break
        case 'v':
          mainWindow?.webContents.paste()
          break
        case 'a':
          mainWindow?.webContents.selectAll()
          break
        case 'z':
          if (input.shift) {
            mainWindow?.webContents.redo()
          } else {
            mainWindow?.webContents.undo()
          }
          break
      }
    }
  })

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const contextMenu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' },
    ])
    contextMenu.popup()
  })

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.webContents.insertCSS(`
      body::before {
        content: '';
        display: block;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 42px;
        -webkit-app-region: drag;
        z-index: 9999;
        pointer-events: none;
      }
      button, a, input, select, textarea, [role="button"], [data-clickable] {
        -webkit-app-region: no-drag;
      }
    `);
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalURL(url)) {
      // Allow the popup — Electron creates a real child BrowserWindow.
      // This is needed for OAuth flows that use window.open() → postMessage().
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 700,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
          },
        },
      };
    }
    // External URL → system browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Configure navigation rules for OAuth popup windows. The popup is created by
  // setWindowOpenHandler above for internal URLs; it then navigates to external
  // OAuth providers via server-side 302 redirects, and back to our domain.
  mainWindow.webContents.on('did-create-window', (childWindow) => {
    childWindow.webContents.on('will-navigate', (event, url) => {
      try {
        const isInternal = isInternalURL(url);

        if (!isInternal && !isTrustedOAuthURL(url)) {
          event.preventDefault();
          shell.openExternal(url);
        }
        // Internal and OAuth provider URLs navigate within the popup — this is the flow
      } catch {
        event.preventDefault();
      }
    });

    // Also handle window.open() inside the popup (some OAuth flows do this)
    childWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isInternalURL(url)) {
        childWindow.loadURL(url);
      } else {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternalURL(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', () => {
    if (mainWindow) {
      saveWindowState(mainWindow);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(APP_URL);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

ipcMain.on('get-app-version', (event) => {
  event.returnValue = app.getVersion();
});

app.on('ready', () => {
  desktopAgent = new DesktopAgentService();
  initAgentIpc(desktopAgent, isTrustedPermissionOrigin);
  desktopAgent.start();
  configureSessionSecurity();
  createMenu();
  createAgentTray();
  createWindow();
  initUpdater();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
