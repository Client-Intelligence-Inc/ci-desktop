import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { resolvePathInScope, ensureParentDirectory } from '../tools/path-scope';
import type { DesktopAgentSettings } from '../agent/types';

function makeSettings(overrides?: Partial<DesktopAgentSettings>): DesktopAgentSettings {
  return {
    displayName: 'Test Device',
    launchAtLogin: false,
    enabled: true,
    gatewayUrl: 'ws://127.0.0.1:47391/connect',
    fileAccessMode: 'selected_folders',
    allowedFolders: [],
    controlMode: 'open_apps',
    approvalMode: 'session',
    allowShell: false,
    deviceApprovalGrants: [],
    ...overrides,
  };
}

describe('resolvePathInScope', () => {
  describe('file access disabled', () => {
    it('throws when fileAccessMode is none', () => {
      const settings = makeSettings({ fileAccessMode: 'none' });
      expect(() => resolvePathInScope('/tmp/test', settings)).toThrow('File access is disabled');
    });
  });

  describe('empty path', () => {
    it('throws for empty string', () => {
      const settings = makeSettings({ fileAccessMode: 'full_disk' });
      expect(() => resolvePathInScope('', settings)).toThrow('non-empty path');
    });

    it('throws for whitespace-only string', () => {
      const settings = makeSettings({ fileAccessMode: 'full_disk' });
      expect(() => resolvePathInScope('   ', settings)).toThrow('non-empty path');
    });
  });

  describe('full_disk mode', () => {
    it('allows any absolute path', () => {
      const settings = makeSettings({ fileAccessMode: 'full_disk' });
      const result = resolvePathInScope('/usr/local/bin', settings);
      expect(result).toBe('/usr/local/bin');
    });

    it('resolves relative paths', () => {
      const settings = makeSettings({ fileAccessMode: 'full_disk' });
      const result = resolvePathInScope('relative/path', settings);
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe('selected_folders mode', () => {
    it('allows path inside allowed folder', () => {
      const tmpDir = os.tmpdir();
      const settings = makeSettings({
        fileAccessMode: 'selected_folders',
        allowedFolders: [tmpDir],
      });
      const result = resolvePathInScope(path.join(tmpDir, 'test.txt'), settings);
      expect(result).toContain('test.txt');
    });

    it('rejects path outside allowed folders', () => {
      const settings = makeSettings({
        fileAccessMode: 'selected_folders',
        allowedFolders: ['/tmp/safe'],
      });
      expect(() => resolvePathInScope('/usr/local/bin', settings))
        .toThrow('outside allowed folders');
    });

    it('rejects when no folders are allowed', () => {
      const settings = makeSettings({
        fileAccessMode: 'selected_folders',
        allowedFolders: [],
      });
      expect(() => resolvePathInScope('/tmp/test', settings))
        .toThrow('outside allowed folders');
    });

    it('allows the allowed folder itself', () => {
      const tmpDir = os.tmpdir();
      const settings = makeSettings({
        fileAccessMode: 'selected_folders',
        allowedFolders: [tmpDir],
      });
      const result = resolvePathInScope(tmpDir, settings);
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe('home expansion', () => {
    it('expands ~ to home directory', () => {
      const settings = makeSettings({ fileAccessMode: 'full_disk' });
      const home = process.env.HOME || '';
      const result = resolvePathInScope('~/Documents', settings);
      expect(result).toBe(path.join(home, 'Documents'));
    });

    it('expands bare ~ to home directory', () => {
      const settings = makeSettings({ fileAccessMode: 'full_disk' });
      const home = process.env.HOME || '';
      const result = resolvePathInScope('~', settings);
      expect(result).toBe(home);
    });
  });
});

describe('ensureParentDirectory', () => {
  it('creates parent directory', () => {
    const tmpPath = path.join(os.tmpdir(), `ci-desktop-test-${process.pid}`, 'sub', 'file.txt');
    ensureParentDirectory(tmpPath);
    const fs = require('fs');
    expect(fs.existsSync(path.dirname(tmpPath))).toBe(true);
    fs.rmSync(path.join(os.tmpdir(), `ci-desktop-test-${process.pid}`), { recursive: true });
  });
});
