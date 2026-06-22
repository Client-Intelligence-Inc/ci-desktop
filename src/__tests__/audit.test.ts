import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'ci-desktop-test-audit-' + process.pid),
  },
}));

import {
  appendAuditEntry,
  readAuditEntries,
  clearAuditEntries,
  getAuditInfo,
  getAuditPath,
} from '../agent/audit';

describe('audit', () => {
  const auditDir = path.dirname(getAuditPath());

  beforeEach(() => {
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.unlinkSync(getAuditPath()); } catch {}
  });

  afterEach(() => {
    try { fs.unlinkSync(getAuditPath()); } catch {}
    try { fs.rmSync(auditDir, { recursive: true }); } catch {}
  });

  describe('appendAuditEntry', () => {
    it('creates audit file and appends entry', () => {
      appendAuditEntry({ action: 'tool.start', result: 'allowed', tool: 'system.info' });
      const entries = readAuditEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('tool.start');
      expect(entries[0].result).toBe('allowed');
      expect(entries[0].tool).toBe('system.info');
      expect(entries[0].timestamp).toBeDefined();
    });

    it('appends multiple entries', () => {
      appendAuditEntry({ action: 'tool.start', result: 'allowed' });
      appendAuditEntry({ action: 'tool.finish', result: 'completed' });
      appendAuditEntry({ action: 'tool.exception', result: 'failed' });
      expect(readAuditEntries()).toHaveLength(3);
    });

    it('redacts sensitive data in target field', () => {
      appendAuditEntry({
        action: 'tool.start',
        result: 'allowed',
        target: 'authorization: bearer sk-secret-key-123',
      });
      const entries = readAuditEntries();
      expect(entries[0].target).toContain('[redacted]');
      expect(entries[0].target).not.toContain('sk-secret-key-123');
    });

    it('redacts password patterns in target', () => {
      appendAuditEntry({
        action: 'tool.start',
        result: 'allowed',
        target: 'password=mysecretpassword',
      });
      const entries = readAuditEntries();
      expect(entries[0].target).toContain('[redacted]');
      expect(entries[0].target).not.toContain('mysecretpassword');
    });

    it('redacts api_key patterns in error', () => {
      appendAuditEntry({
        action: 'tool.exception',
        result: 'failed',
        error: 'failed with api_key=abc123xyz',
      });
      const entries = readAuditEntries();
      expect(entries[0].error).toContain('[redacted]');
      expect(entries[0].error).not.toContain('abc123xyz');
    });
  });

  describe('readAuditEntries', () => {
    it('returns empty array when no audit file', () => {
      expect(readAuditEntries()).toEqual([]);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        appendAuditEntry({ action: `action-${i}`, result: 'allowed' });
      }
      const entries = readAuditEntries(3);
      expect(entries).toHaveLength(3);
      expect(entries[0].action).toBe('action-7');
    });

    it('defaults to 100 entries when limit is invalid', () => {
      for (let i = 0; i < 5; i++) {
        appendAuditEntry({ action: `action-${i}`, result: 'allowed' });
      }
      const entries = readAuditEntries('invalid' as any);
      expect(entries).toHaveLength(5);
    });

    it('caps limit at 500', () => {
      for (let i = 0; i < 5; i++) {
        appendAuditEntry({ action: `action-${i}`, result: 'allowed' });
      }
      const entries = readAuditEntries(9999);
      expect(entries).toHaveLength(5);
    });
  });

  describe('clearAuditEntries', () => {
    it('empties the audit file', () => {
      appendAuditEntry({ action: 'test', result: 'allowed' });
      expect(readAuditEntries()).toHaveLength(1);
      clearAuditEntries();
      expect(readAuditEntries()).toEqual([]);
    });
  });

  describe('getAuditInfo', () => {
    it('returns zero entries for fresh audit', () => {
      const info = getAuditInfo();
      expect(info.entries).toBe(0);
      expect(info.maxEntries).toBeGreaterThan(0);
    });

    it('reports correct entry count', () => {
      appendAuditEntry({ action: 'a', result: 'allowed' });
      appendAuditEntry({ action: 'b', result: 'allowed' });
      const info = getAuditInfo();
      expect(info.entries).toBe(2);
      expect(info.bytes).toBeGreaterThan(0);
    });
  });
});
