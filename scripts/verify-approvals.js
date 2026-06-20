#!/usr/bin/env node

const {
  approvalGrantScope,
  hasDeviceApprovalGrant,
  normalizeApprovalGrants,
  shouldRequestApproval,
  withDeviceApprovalGrant,
} = require('../dist/agent/approvals');

const baseSettings = {
  displayName: 'Verifier',
  launchAtLogin: false,
  enabled: false,
  gatewayUrl: 'ws://127.0.0.1:1',
  fileAccessMode: 'selected_folders',
  allowedFolders: [],
  controlMode: 'disabled',
  approvalMode: 'device',
  allowShell: false,
  deviceApprovalGrants: [],
};

const grants = withDeviceApprovalGrant(baseSettings, 'screen.screenshot', '2026-06-19T00:00:00.000Z');
assert(grants.length === 1, 'device approval grant should be created');
assert(grants[0].tool === 'screen.screenshot', 'device approval grant should store tool');
assert(grants[0].scope === 'device', 'device approval grant should store device scope');

const grantedSettings = { ...baseSettings, deviceApprovalGrants: grants };
assert(hasDeviceApprovalGrant(grantedSettings, 'screen.screenshot'), 'stored grant should be found');
assert(!hasDeviceApprovalGrant(grantedSettings, 'input.click'), 'ungranted tool should not be found');

assert(
  shouldRequestApproval({
    approvalMode: 'device',
    isApprovalWorthy: true,
    hasSessionApproval: false,
    hasDeviceApproval: false,
  }),
  'device mode should request approval before a device grant exists',
);

assert(
  !shouldRequestApproval({
    approvalMode: 'device',
    isApprovalWorthy: true,
    hasSessionApproval: false,
    hasDeviceApproval: true,
  }),
  'device mode should not request approval after a device grant exists',
);

assert(
  !shouldRequestApproval({
    approvalMode: 'session',
    isApprovalWorthy: false,
    hasSessionApproval: false,
    hasDeviceApproval: false,
  }),
  'non-risky tool should not prompt in session mode',
);

assert(
  shouldRequestApproval({
    approvalMode: 'ask_every_time',
    isApprovalWorthy: false,
    hasSessionApproval: false,
    hasDeviceApproval: false,
  }),
  'ask_every_time should prompt even for low-risk tools',
);

assert(
  !shouldRequestApproval({
    approvalMode: 'always_for_owner',
    isApprovalWorthy: false,
    hasSessionApproval: false,
    hasDeviceApproval: false,
  }),
  'always_for_owner should not prompt for low-risk tools',
);

assert(
  shouldRequestApproval({
    approvalMode: 'always_for_owner',
    isApprovalWorthy: true,
    hasSessionApproval: false,
    hasDeviceApproval: false,
  }),
  'always_for_owner should still prompt for approval-worthy tools',
);

assert(approvalGrantScope({ approved: true, scope: 'once' }, 'device') === 'once', 'explicit once scope should be honored');
assert(approvalGrantScope({ approved: true }, 'device') === 'device', 'device mode should default to device scope');
assert(approvalGrantScope({ approved: true }, 'session') === 'session', 'session mode should default to session scope');

const normalized = normalizeApprovalGrants([
  { tool: 'input.click', scope: 'device', grantedAt: '2026-06-19T00:00:00.000Z' },
  { tool: '', scope: 'device', grantedAt: 'bad' },
  { tool: 'screen.stream', scope: 'session', grantedAt: 'bad' },
]);
assert(normalized.length === 1, 'normalization should keep only valid device approval grants');
assert(normalized[0].tool === 'input.click', 'normalization should preserve valid grant');

console.log('Approval policy verification passed');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
