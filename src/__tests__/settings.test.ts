import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const testDir = path.join(os.tmpdir(), 'ci-desktop-test-settings-' + process.pid);

vi.mock('electron', () => ({
  app: {
    getPath: () => testDir,
  },
}));

import {
  getDefaultAgentSettings,
  loadAgentSettings,
  saveAgentSettings,
  updateAgentSettings,
  loadLegacyDeviceTokenFromSettingsFile,
  redactPersistedSettings,
  getAgentSettingsPath,
} from '../agent/settings';

describe('settings', () => {
  const settingsPath = getAgentSettingsPath();

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    try { fs.unlinkSync(settingsPath); } catch {}
  });

  afterEach(() => {
    try { fs.unlinkSync(settingsPath); } catch {}
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
  });

  describe('getDefaultAgentSettings', () => {
    it('returns defaults with expected shape', () => {
      const defaults = getDefaultAgentSettings();
      expect(defaults.displayName).toBeTruthy();
      expect(defaults.launchAtLogin).toBe(false);
      expect(defaults.enabled).toBe(false);
      expect(defaults.gatewayUrl).toContain('127.0.0.1');
      expect(defaults.fileAccessMode).toBe('selected_folders');
      expect(defaults.allowedFolders).toEqual([]);
      expect(defaults.controlMode).toBe('open_apps');
      expect(defaults.approvalMode).toBe('session');
      expect(defaults.allowShell).toBe(false);
      expect(defaults.deviceApprovalGrants).toEqual([]);
    });
  });

  describe('loadAgentSettings', () => {
    it('returns defaults when no file exists', () => {
      const settings = loadAgentSettings();
      expect(settings.enabled).toBe(false);
      expect(settings.allowedFolders).toEqual([]);
    });

    it('loads persisted settings', () => {
      const data = {
        enabled: true,
        displayName: 'Custom Name',
        allowedFolders: ['/tmp/safe'],
      };
      fs.writeFileSync(settingsPath, JSON.stringify(data));

      const settings = loadAgentSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.displayName).toBe('Custom Name');
      expect(settings.allowedFolders).toEqual(['/tmp/safe']);
    });

    it('strips deviceToken from persisted data', () => {
      const data = {
        enabled: true,
        deviceToken: 'secret-token',
        jobSigningSecret: 'secret-key',
      };
      fs.writeFileSync(settingsPath, JSON.stringify(data));

      const settings = loadAgentSettings();
      expect(settings.deviceToken).toBeUndefined();
      expect(settings.jobSigningSecret).toBeUndefined();
    });

    it('defaults allowedFolders to empty array for invalid value', () => {
      const data = { allowedFolders: 'not-an-array' };
      fs.writeFileSync(settingsPath, JSON.stringify(data));

      const settings = loadAgentSettings();
      expect(settings.allowedFolders).toEqual([]);
    });

    it('returns defaults for corrupted JSON', () => {
      fs.writeFileSync(settingsPath, 'not-json{{{');
      const settings = loadAgentSettings();
      expect(settings.enabled).toBe(false);
    });
  });

  describe('saveAgentSettings', () => {
    it('persists settings to disk', () => {
      const settings = getDefaultAgentSettings();
      settings.enabled = true;
      settings.displayName = 'Saved Device';
      saveAgentSettings(settings);

      const loaded = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(loaded.enabled).toBe(true);
      expect(loaded.displayName).toBe('Saved Device');
    });

    it('strips secrets before persisting', () => {
      const settings = {
        ...getDefaultAgentSettings(),
        deviceToken: 'secret-token-123',
        jobSigningSecret: 'sha256:abc',
      };
      saveAgentSettings(settings);

      const loaded = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(loaded.deviceToken).toBeUndefined();
      expect(loaded.jobSigningSecret).toBeUndefined();
    });
  });

  describe('updateAgentSettings', () => {
    it('merges patch with existing settings', () => {
      saveAgentSettings(getDefaultAgentSettings());
      const updated = updateAgentSettings({ enabled: true, displayName: 'Updated' });
      expect(updated.enabled).toBe(true);
      expect(updated.displayName).toBe('Updated');
      expect(updated.approvalMode).toBe('session');
    });
  });

  describe('loadLegacyDeviceTokenFromSettingsFile', () => {
    it('returns undefined when no file exists', () => {
      expect(loadLegacyDeviceTokenFromSettingsFile()).toBeUndefined();
    });

    it('returns token when present in settings file', () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ deviceToken: 'legacy-token' }));
      expect(loadLegacyDeviceTokenFromSettingsFile()).toBe('legacy-token');
    });

    it('returns undefined for empty token', () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ deviceToken: '' }));
      expect(loadLegacyDeviceTokenFromSettingsFile()).toBeUndefined();
    });

    it('returns undefined for non-string token', () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ deviceToken: 123 }));
      expect(loadLegacyDeviceTokenFromSettingsFile()).toBeUndefined();
    });
  });

  describe('redactPersistedSettings', () => {
    it('removes deviceToken and jobSigningSecret', () => {
      const settings = {
        ...getDefaultAgentSettings(),
        deviceToken: 'secret',
        jobSigningSecret: 'sha256:abc',
      };
      const redacted = redactPersistedSettings(settings);
      expect('deviceToken' in redacted).toBe(false);
      expect('jobSigningSecret' in redacted).toBe(false);
      expect(redacted.enabled).toBe(false);
    });
  });
});
