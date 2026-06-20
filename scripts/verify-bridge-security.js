#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DesktopAgentService } = require('../dist/agent/service');
const { getDefaultAgentSettings, saveAgentSettings } = require('../dist/agent/settings');

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-agent-bridge-'));
  process.env.CI_DESKTOP_AGENT_SETTINGS_PATH = path.join(tmpDir, 'settings.json');
  process.env.CI_DESKTOP_AGENT_AUDIT_PATH = path.join(tmpDir, 'audit.jsonl');

  try {
    const service = new DesktopAgentService();

    service.updateSettings({
      displayName: 'Bridge Verifier',
      deviceId: 'forged-device',
      ownerUserId: 'forged-owner',
      deviceApprovalGrants: [{
        tool: 'screen.screenshot',
        scope: 'device',
        grantedAt: new Date().toISOString(),
      }],
    });
    const statusAfterForgedSettings = await service.getStatus();
    assert(statusAfterForgedSettings.displayName === 'Bridge Verifier', 'trusted bridge should still allow safe displayName updates');
    assert(!statusAfterForgedSettings.deviceId, 'trusted bridge updateSettings should not set paired device identity');
    assert(!statusAfterForgedSettings.ownerUserId, 'trusted bridge updateSettings should not set paired owner identity');
    const persistedSettings = fs.readFileSync(process.env.CI_DESKTOP_AGENT_SETTINGS_PATH, 'utf-8');
    assert(!persistedSettings.includes('forged-device'), 'trusted bridge updateSettings should not persist forged device identity');
    assert(!persistedSettings.includes('forged-owner'), 'trusted bridge updateSettings should not persist forged owner identity');
    assert(!persistedSettings.includes('screen.screenshot'), 'trusted bridge updateSettings should not persist forged approval grants');

    service.updateSettings({
      gatewayUrl: 'ws://clientintelligence.ai/api/desktop-agent/connect',
    });
    const statusAfterInsecureGateway = await service.getStatus();
    assert(
      statusAfterInsecureGateway.gatewayUrl !== 'ws://clientintelligence.ai/api/desktop-agent/connect',
      'trusted bridge updateSettings should reject insecure non-loopback gateway URLs',
    );

    service.updateSettings({
      gatewayUrl: 'wss://clientintelligence.ai/api/desktop-agent/connect',
    });
    const statusAfterSecureGateway = await service.getStatus();
    assert(
      statusAfterSecureGateway.gatewayUrl === 'wss://clientintelligence.ai/api/desktop-agent/connect',
      'trusted bridge updateSettings should accept secure gateway URLs',
    );

    service.updateSettings({
      gatewayUrl: 'https://clientintelligence.ai',
    });
    const statusAfterHttpsGateway = await service.getStatus();
    assert(
      statusAfterHttpsGateway.gatewayUrl === 'https://clientintelligence.ai',
      'trusted bridge updateSettings should accept secure HTTPS polling gateway URLs',
    );

    const forgedAllowedFolder = path.join(tmpDir, 'forged-folder');
    fs.mkdirSync(forgedAllowedFolder);
    service.updateSettings({
      fileAccessMode: 'selected_folders',
      allowedFolders: [forgedAllowedFolder],
    });
    const statusAfterForgedFolders = await service.getStatus();
    assert(
      statusAfterForgedFolders.fileAccessMode === 'selected_folders',
      'trusted bridge updateSettings should still allow selected-folder mode',
    );
    assert(
      !statusAfterForgedFolders.allowedFolders.includes(forgedAllowedFolder),
      'trusted bridge updateSettings should not add allowed folders without the native folder picker',
    );
    service.addAllowedFolderFromNativePicker(forgedAllowedFolder);
    const statusAfterNativeFolder = await service.getStatus();
    assert(
      statusAfterNativeFolder.allowedFolders.includes(forgedAllowedFolder),
      'native folder picker path should add selected folders',
    );

    let invalidPermissionRejected = false;
    try {
      service.openPermissionSettings('not_a_permission');
    } catch (error) {
      invalidPermissionRejected = String(error instanceof Error ? error.message : error).includes('Unsupported macOS permission shortcut');
    }
    assert(
      invalidPermissionRejected,
      'trusted bridge should reject unknown macOS permission shortcuts before opening native settings',
    );

    const lowRisk = await service.runLocalTool('system.info', {});
    assert(lowRisk.ok, `trusted bridge should allow non-approval diagnostic tools: ${lowRisk.error || ''}`);

    const denied = await service.runLocalTool('files.write', {
      path: path.join(tmpDir, 'blocked.txt'),
      content: 'blocked',
    });
    assert(!denied.ok, 'trusted bridge should deny approval-required tools');
    assert(
      denied.error.includes('Approval-required capability cannot run through trusted bridge'),
      'trusted bridge denial should explain that approval-required tools must use desktop jobs',
    );
    assert(!fs.existsSync(path.join(tmpDir, 'blocked.txt')), 'denied local tool should not execute file write');

    const audit = service.readAuditEntries(10);
    assert(
      audit.some((entry) => (
        entry.tool === 'files.write' &&
        entry.action === 'local_tool.dispatch' &&
        entry.result === 'denied'
      )),
      'trusted bridge denial should be audited',
    );

    saveAgentSettings({
      ...getDefaultAgentSettings(),
      displayName: 'Bridge Verifier',
      enabled: true,
      deviceId: 'existing-device',
      ownerUserId: 'existing-owner',
      gatewayUrl: 'ws://127.0.0.1:1',
      deviceApprovalGrants: [{
        tool: 'screen.screenshot',
        scope: 'device',
        grantedAt: new Date().toISOString(),
      }],
    });
    const pairService = new DesktopAgentService();
    process.env.CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING = '1';
    try {
      await pairService.pairPersonalDevice('paired-owner');
    } finally {
      delete process.env.CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING;
    }
    const settingsAfterPair = fs.readFileSync(process.env.CI_DESKTOP_AGENT_SETTINGS_PATH, 'utf-8');
    assert(!settingsAfterPair.includes('screen.screenshot'), 'pairing should clear stale device approval grants');
    assert(settingsAfterPair.includes('paired-owner'), 'pairing should persist the new paired owner');
    pairService.disconnect();

    saveAgentSettings({
      ...getDefaultAgentSettings(),
      displayName: 'Bridge Verifier',
      enabled: true,
      deviceId: 'revoked-device',
      ownerUserId: 'revoked-owner',
      gatewayUrl: 'ws://127.0.0.1:1',
      deviceApprovalGrants: [{
        tool: 'input.click',
        scope: 'device',
        grantedAt: new Date().toISOString(),
      }],
    });
    const revokeService = new DesktopAgentService();
    await revokeService.revokePersonalDevice();
    const settingsAfterRevoke = fs.readFileSync(process.env.CI_DESKTOP_AGENT_SETTINGS_PATH, 'utf-8');
    assert(!settingsAfterRevoke.includes('input.click'), 'revocation should clear stale device approval grants');
    assert(!settingsAfterRevoke.includes('revoked-device'), 'revocation should clear paired device identity');
    assert(!settingsAfterRevoke.includes('revoked-owner'), 'revocation should clear paired owner identity');

    console.log('Bridge security verification passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
