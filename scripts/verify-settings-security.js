#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-agent-settings-security-'));
const settingsPath = path.join(tmpDir, 'desktop-agent-settings.json');
process.env.CI_DESKTOP_AGENT_SETTINGS_PATH = settingsPath;

const {
  getDefaultAgentSettings,
  loadAgentSettings,
  loadLegacyDeviceTokenFromSettingsFile,
  saveAgentSettings,
  updateAgentSettings,
} = require('../dist/agent/settings');

try {
  const defaults = getDefaultAgentSettings();
  saveAgentSettings({
    ...defaults,
    enabled: true,
    deviceId: 'verify-device',
    ownerUserId: 'verify-user',
    deviceToken: 'secret-token-that-must-not-persist',
    jobSigningSecret: 'secret-signing-key-that-must-not-persist',
  });

  let persisted = fs.readFileSync(settingsPath, 'utf-8');
  assert(!persisted.includes('secret-token-that-must-not-persist'), 'saveAgentSettings should not write device token');
  assert(!persisted.includes('secret-signing-key-that-must-not-persist'), 'saveAgentSettings should not write job signing secret');
  assert(!JSON.parse(persisted).deviceToken, 'settings JSON should omit deviceToken key');
  assert(!JSON.parse(persisted).jobSigningSecret, 'settings JSON should omit jobSigningSecret key');

  const updated = updateAgentSettings({
    deviceToken: 'runtime-only-token',
    jobSigningSecret: 'runtime-only-signing-secret',
    displayName: 'Verifier',
  });
  assert(updated.deviceToken === 'runtime-only-token', 'updateAgentSettings may return runtime token in memory');
  assert(updated.jobSigningSecret === 'runtime-only-signing-secret', 'updateAgentSettings may return runtime signing secret in memory');
  persisted = fs.readFileSync(settingsPath, 'utf-8');
  assert(!persisted.includes('runtime-only-token'), 'updateAgentSettings should not persist runtime token');
  assert(!persisted.includes('runtime-only-signing-secret'), 'updateAgentSettings should not persist runtime signing secret');
  assert(!JSON.parse(persisted).deviceToken, 'updated settings JSON should omit deviceToken key');
  assert(!JSON.parse(persisted).jobSigningSecret, 'updated settings JSON should omit jobSigningSecret key');

  fs.writeFileSync(settingsPath, JSON.stringify({
    ...defaults,
    deviceId: 'legacy-device',
    deviceToken: 'legacy-token',
    jobSigningSecret: 'legacy-signing-secret',
  }, null, 2));
  const loaded = loadAgentSettings();
  assert(!loaded.deviceToken, 'loadAgentSettings should strip legacy deviceToken');
  assert(!loaded.jobSigningSecret, 'loadAgentSettings should strip legacy jobSigningSecret');
  assert(loadLegacyDeviceTokenFromSettingsFile() === 'legacy-token', 'legacy token should be available for migration');

  saveAgentSettings(loaded);
  persisted = fs.readFileSync(settingsPath, 'utf-8');
  assert(!persisted.includes('legacy-token'), 'saving loaded settings should remove legacy token from disk');
  assert(!persisted.includes('legacy-signing-secret'), 'saving loaded settings should remove legacy signing secret from disk');

  console.log('Settings security verification passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
