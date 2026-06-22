import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/ci-desktop-test' },
}));

vi.mock('../agent/audit', () => ({
  appendAuditEntry: vi.fn(),
}));

import {
  getCapabilityNames,
  getCapabilityManifest,
  getCapability,
  validateCapabilityInput,
  summarizeAuditTarget,
} from '../agent/capabilities';

describe('getCapabilityManifest', () => {
  it('returns an array of capabilities', () => {
    const manifest = getCapabilityManifest();
    expect(Array.isArray(manifest)).toBe(true);
    expect(manifest.length).toBeGreaterThan(20);
  });

  it('each capability has required fields', () => {
    for (const cap of getCapabilityManifest()) {
      expect(cap.name).toBeTruthy();
      expect(cap.description).toBeTruthy();
      expect(['low', 'medium', 'high']).toContain(cap.risk);
      expect(Array.isArray(cap.requiredMacPermissions)).toBe(true);
      expect(typeof cap.requiresApproval).toBe('boolean');
      expect(typeof cap.canRunUnattended).toBe('boolean');
      expect(cap.inputSchema).toBeDefined();
      expect(cap.outputSchema).toBeDefined();
    }
  });
});

describe('getCapabilityNames', () => {
  it('returns an array of tool name strings', () => {
    const names = getCapabilityNames();
    expect(names).toContain('system.info');
    expect(names).toContain('files.read');
    expect(names).toContain('screen.screenshot');
    expect(names).toContain('input.click');
    expect(names).toContain('shell.run');
  });
});

describe('getCapability', () => {
  it('returns capability by name', () => {
    const cap = getCapability('system.info');
    expect(cap).toBeDefined();
    expect(cap!.name).toBe('system.info');
    expect(cap!.risk).toBe('low');
  });

  it('returns undefined for unknown capability', () => {
    expect(getCapability('nonexistent.tool')).toBeUndefined();
  });
});

describe('validateCapabilityInput', () => {
  it('validates system.info with empty args', () => {
    const result = validateCapabilityInput('system.info', {});
    expect(result.ok).toBe(true);
  });

  it('validates files.read with required path', () => {
    const result = validateCapabilityInput('files.read', { path: '/tmp/test' });
    expect(result.ok).toBe(true);
  });

  it('rejects files.read without path', () => {
    const result = validateCapabilityInput('files.read', {});
    expect(result.ok).toBe(false);
  });

  it('validates browser.open_url with valid url', () => {
    const result = validateCapabilityInput('browser.open_url', { url: 'https://example.com' });
    expect(result.ok).toBe(true);
  });

  it('rejects browser.open_url without url', () => {
    const result = validateCapabilityInput('browser.open_url', {});
    expect(result.ok).toBe(false);
  });

  it('rejects unknown capability', () => {
    const result = validateCapabilityInput('nonexistent.tool', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown');
  });

  it('validates input.click with coordinates', () => {
    const result = validateCapabilityInput('input.click', { x: 100, y: 200 });
    expect(result.ok).toBe(true);
  });

  it('rejects input.click without coordinates', () => {
    const result = validateCapabilityInput('input.click', {});
    expect(result.ok).toBe(false);
  });

  it('validates shell.run with command', () => {
    const result = validateCapabilityInput('shell.run', { command: 'ls -la' });
    expect(result.ok).toBe(true);
  });
});

describe('summarizeAuditTarget', () => {
  it('summarizes browser URL to host', () => {
    expect(summarizeAuditTarget('browser.open_url', { url: 'https://example.com/path?query=1' }))
      .toBe('https://example.com');
  });

  it('summarizes file path', () => {
    expect(summarizeAuditTarget('files.read', { path: '/tmp/test.txt' }))
      .toBe('/tmp/test.txt');
  });

  it('summarizes file copy with source and destination', () => {
    expect(summarizeAuditTarget('files.copy', { sourcePath: '/a', destinationPath: '/b' }))
      .toBe('/a -> /b');
  });

  it('summarizes app name', () => {
    expect(summarizeAuditTarget('apps.open', { name: 'Safari' }))
      .toBe('Safari');
  });

  it('summarizes click coordinates', () => {
    expect(summarizeAuditTarget('input.click', { x: 100, y: 200 }))
      .toBe('x=100 y=200');
  });

  it('summarizes input click with expected app', () => {
    expect(summarizeAuditTarget('input.click', { x: 10, y: 20, expectedFrontmostApp: 'Finder' }))
      .toBe('x=10 y=20 app=Finder');
  });

  it('summarizes drag coordinates', () => {
    expect(summarizeAuditTarget('input.drag', { fromX: 0, fromY: 0, toX: 100, toY: 100 }))
      .toBe('from=0,0 to=100,100');
  });

  it('summarizes scroll delta', () => {
    expect(summarizeAuditTarget('input.scroll', { deltaY: -3 }))
      .toBe('delta=0,-3');
  });

  it('summarizes hotkey', () => {
    expect(summarizeAuditTarget('input.hotkey', { key: 'c', modifiers: ['meta'] }))
      .toBe('key=c');
  });

  it('summarizes type_text with expected app', () => {
    expect(summarizeAuditTarget('input.type_text', { text: 'hello', expectedFrontmostApp: 'Terminal' }))
      .toBe('app=Terminal');
  });

  it('summarizes type_text without expected app', () => {
    expect(summarizeAuditTarget('input.type_text', { text: 'hello' }))
      .toBe('focused field');
  });

  it('summarizes secret name', () => {
    expect(summarizeAuditTarget('secrets.save', { name: 'my-api-key' }))
      .toBe('secret:my-api-key');
  });

  it('summarizes automation', () => {
    expect(summarizeAuditTarget('automation.applescript', { script: 'tell app "Finder"' }))
      .toBe('applescript');
  });

  it('summarizes shell command', () => {
    expect(summarizeAuditTarget('shell.run', { command: 'ls', cwd: '/tmp' }))
      .toBe('ls');
  });

  it('summarizes system.storage path', () => {
    expect(summarizeAuditTarget('system.storage', { path: '/' }))
      .toBe('/');
  });

  it('returns undefined for null args', () => {
    expect(summarizeAuditTarget('system.info', null)).toBeUndefined();
  });

  it('returns undefined for array args', () => {
    expect(summarizeAuditTarget('system.info', [])).toBeUndefined();
  });

  it('returns undefined for screen sources', () => {
    expect(summarizeAuditTarget('screen.sources', {})).toBeUndefined();
  });

  it('summarizes screen screenshot format', () => {
    expect(summarizeAuditTarget('screen.screenshot', { format: 'png' }))
      .toBe('png');
  });
});
