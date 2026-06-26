import { describe, it, expect } from 'vitest';
import {
  normalizeApprovalGrants,
  hasDeviceApprovalGrant,
  withDeviceApprovalGrant,
  shouldRequestApproval,
  approvalGrantScope,
} from '../agent/approvals';
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

describe('normalizeApprovalGrants', () => {
  it('returns empty array for non-array input', () => {
    expect(normalizeApprovalGrants(null)).toEqual([]);
    expect(normalizeApprovalGrants(undefined)).toEqual([]);
    expect(normalizeApprovalGrants('string')).toEqual([]);
    expect(normalizeApprovalGrants(42)).toEqual([]);
  });

  it('filters out invalid grants', () => {
    const grants = normalizeApprovalGrants([
      { tool: 'system.info', scope: 'device', grantedAt: '2026-01-01T00:00:00Z' },
      { tool: '', scope: 'device', grantedAt: '2026-01-01T00:00:00Z' },
      { scope: 'device', grantedAt: '2026-01-01T00:00:00Z' },
      { tool: 'system.info', scope: 'session', grantedAt: '2026-01-01T00:00:00Z' },
      null,
      42,
    ]);
    expect(grants).toHaveLength(1);
    expect(grants[0].tool).toBe('system.info');
  });

  it('normalizes valid grants', () => {
    const grants = normalizeApprovalGrants([
      { tool: 'files.read', scope: 'device', grantedAt: '2026-01-01', extra: 'ignored' },
    ]);
    expect(grants).toEqual([{ tool: 'files.read', scope: 'device', grantedAt: '2026-01-01' }]);
  });
});

describe('hasDeviceApprovalGrant', () => {
  it('returns true when grant exists', () => {
    const settings = makeSettings({
      deviceApprovalGrants: [{ tool: 'system.info', scope: 'device', grantedAt: '2026-01-01' }],
    });
    expect(hasDeviceApprovalGrant(settings, 'system.info')).toBe(true);
  });

  it('returns false when no grant', () => {
    const settings = makeSettings();
    expect(hasDeviceApprovalGrant(settings, 'system.info')).toBe(false);
  });

  it('returns false for different tool', () => {
    const settings = makeSettings({
      deviceApprovalGrants: [{ tool: 'files.read', scope: 'device', grantedAt: '2026-01-01' }],
    });
    expect(hasDeviceApprovalGrant(settings, 'system.info')).toBe(false);
  });
});

describe('withDeviceApprovalGrant', () => {
  it('adds a new device grant', () => {
    const settings = makeSettings();
    const grants = withDeviceApprovalGrant(settings, 'system.info', '2026-06-01');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toEqual({ tool: 'system.info', scope: 'device', grantedAt: '2026-06-01' });
  });

  it('replaces existing grant for same tool', () => {
    const settings = makeSettings({
      deviceApprovalGrants: [{ tool: 'system.info', scope: 'device', grantedAt: '2026-01-01' }],
    });
    const grants = withDeviceApprovalGrant(settings, 'system.info', '2026-06-01');
    expect(grants).toHaveLength(1);
    expect(grants[0].grantedAt).toBe('2026-06-01');
  });

  it('preserves other grants', () => {
    const settings = makeSettings({
      deviceApprovalGrants: [{ tool: 'files.read', scope: 'device', grantedAt: '2026-01-01' }],
    });
    const grants = withDeviceApprovalGrant(settings, 'system.info', '2026-06-01');
    expect(grants).toHaveLength(2);
  });
});

describe('shouldRequestApproval', () => {
  it('returns true for ask_every_time mode', () => {
    expect(shouldRequestApproval({
      approvalMode: 'ask_every_time',
      isApprovalWorthy: true,
      hasSessionApproval: false,
      hasDeviceApproval: false,
    })).toBe(true);
  });

  it('returns true for ask_every_time even with prior approvals', () => {
    expect(shouldRequestApproval({
      approvalMode: 'ask_every_time',
      isApprovalWorthy: true,
      hasSessionApproval: true,
      hasDeviceApproval: true,
    })).toBe(true);
  });

  it('skips approval in session mode with session approval', () => {
    expect(shouldRequestApproval({
      approvalMode: 'session',
      isApprovalWorthy: true,
      hasSessionApproval: true,
      hasDeviceApproval: false,
    })).toBe(false);
  });

  it('requests approval in session mode without session approval', () => {
    expect(shouldRequestApproval({
      approvalMode: 'session',
      isApprovalWorthy: true,
      hasSessionApproval: false,
      hasDeviceApproval: false,
    })).toBe(true);
  });

  it('skips approval in device mode with device approval', () => {
    expect(shouldRequestApproval({
      approvalMode: 'device',
      isApprovalWorthy: true,
      hasSessionApproval: false,
      hasDeviceApproval: true,
    })).toBe(false);
  });

  it('skips non-approval-worthy in always_for_owner mode', () => {
    expect(shouldRequestApproval({
      approvalMode: 'always_for_owner',
      isApprovalWorthy: false,
      hasSessionApproval: false,
      hasDeviceApproval: false,
    })).toBe(false);
  });

  it('requires approval for approval-worthy in always_for_owner mode', () => {
    expect(shouldRequestApproval({
      approvalMode: 'always_for_owner',
      isApprovalWorthy: true,
      hasSessionApproval: false,
      hasDeviceApproval: false,
    })).toBe(true);
  });
});

describe('approvalGrantScope', () => {
  it('uses response scope when provided', () => {
    expect(approvalGrantScope({ scope: 'device' }, 'session')).toBe('device');
  });

  it('falls back to session for session mode', () => {
    expect(approvalGrantScope({}, 'session')).toBe('session');
  });

  it('falls back to device for device mode', () => {
    expect(approvalGrantScope({}, 'device')).toBe('device');
  });

  it('defaults to once for ask_every_time mode', () => {
    expect(approvalGrantScope({}, 'ask_every_time')).toBe('once');
  });

  it('defaults to once for always_for_owner mode', () => {
    expect(approvalGrantScope({}, 'always_for_owner')).toBe('once');
  });
});
