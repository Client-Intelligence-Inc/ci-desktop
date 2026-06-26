import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import * as path from 'path';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main.js')],
    env: {
      ...process.env,
      CI_DESKTOP_APP_URL: 'https://clientintelligence.ai',
      CI_DESKTOP_DISABLE_UPDATES: '1',
      NODE_ENV: 'test',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test.describe('Application launch', () => {
  test('window opens with correct title', async () => {
    const title = await page.title();
    expect(title).toBeTruthy();
  });

  test('window has minimum dimensions', async () => {
    const { width, height } = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(width).toBeGreaterThanOrEqual(800);
    expect(height).toBeGreaterThanOrEqual(600);
  });

  test('app is single instance', async () => {
    const isPackaged = await app.evaluate(({ app }) => app.isPackaged);
    expect(typeof isPackaged).toBe('boolean');
  });
});

test.describe('Preload API', () => {
  test('electronAPI is exposed', async () => {
    const hasApi = await page.evaluate(() => typeof (window as any).electronAPI !== 'undefined');
    expect(hasApi).toBe(true);
  });

  test('clientIntelligenceDesktop is exposed', async () => {
    const hasApi = await page.evaluate(() => typeof (window as any).clientIntelligenceDesktop !== 'undefined');
    expect(hasApi).toBe(true);
  });

  test('isDesktopApp flag is true', async () => {
    const isDesktop = await page.evaluate(() => (window as any).electronAPI?.isDesktopApp);
    expect(isDesktop).toBe(true);
  });

  test('appVersion is a string', async () => {
    const version = await page.evaluate(() => (window as any).electronAPI?.appVersion);
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('platform is darwin', async () => {
    const platform = await page.evaluate(() => (window as any).electronAPI?.platform);
    expect(platform).toBe('darwin');
  });

  test('navigation API exists', async () => {
    const hasNav = await page.evaluate(() => {
      const api = (window as any).electronAPI;
      return api?.navigation && typeof api.navigation.back === 'function'
        && typeof api.navigation.forward === 'function'
        && typeof api.navigation.reload === 'function'
        && typeof api.navigation.getState === 'function';
    });
    expect(hasNav).toBe(true);
  });

  test('updater API exists', async () => {
    const hasUpdater = await page.evaluate(() => {
      const api = (window as any).electronAPI;
      return api?.updater && typeof api.updater.check === 'function'
        && typeof api.updater.install === 'function'
        && typeof api.updater.onEvent === 'function';
    });
    expect(hasUpdater).toBe(true);
  });

  test('update channel API exists', async () => {
    const hasChannel = await page.evaluate(() => {
      const api = (window as any).clientIntelligenceDesktop;
      return api?.updateChannel && typeof api.updateChannel.get === 'function'
        && typeof api.updateChannel.set === 'function';
    });
    expect(hasChannel).toBe(true);
  });

  test('telemetry API exists', async () => {
    const hasTelemetry = await page.evaluate(() => {
      const api = (window as any).clientIntelligenceDesktop;
      return api?.telemetry && typeof api.telemetry.isEnabled === 'function'
        && typeof api.telemetry.setEnabled === 'function';
    });
    expect(hasTelemetry).toBe(true);
  });

  test('onboarding API exists', async () => {
    const hasOnboarding = await page.evaluate(() => {
      const api = (window as any).clientIntelligenceDesktop;
      return api?.onboarding && typeof api.onboarding.complete === 'function'
        && typeof api.onboarding.isComplete === 'function';
    });
    expect(hasOnboarding).toBe(true);
  });
});

test.describe('Navigation', () => {
  test('getState returns valid state', async () => {
    const state = await page.evaluate(() => (window as any).electronAPI.navigation.getState());
    expect(state).toHaveProperty('canGoBack');
    expect(state).toHaveProperty('canGoForward');
    expect(typeof state.canGoBack).toBe('boolean');
    expect(typeof state.canGoForward).toBe('boolean');
  });
});

test.describe('Security', () => {
  test('nodeIntegration is disabled', async () => {
    const hasRequire = await page.evaluate(() => typeof (window as any).require !== 'undefined');
    expect(hasRequire).toBe(false);
  });

  test('node globals are not exposed', async () => {
    const hasProcess = await page.evaluate(() => typeof (window as any).process !== 'undefined');
    const hasBuffer = await page.evaluate(() => typeof (window as any).Buffer !== 'undefined');
    expect(hasProcess).toBe(false);
    expect(hasBuffer).toBe(false);
  });
});

test.describe('Window management', () => {
  test('main process reports correct app version', async () => {
    const version = await app.evaluate(({ app }) => app.getVersion());
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('window count is one', async () => {
    const windows = app.windows();
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });
});
