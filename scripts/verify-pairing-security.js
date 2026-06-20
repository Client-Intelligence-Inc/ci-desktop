#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-agent-pairing-'));
  process.env.CI_DESKTOP_AGENT_SETTINGS_PATH = path.join(tmpDir, 'settings.json');
  process.env.CI_DESKTOP_AGENT_AUDIT_PATH = path.join(tmpDir, 'audit.jsonl');
  delete process.env.CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING;

  const { DesktopAgentService } = require('../dist/agent/service');
  const { getDesktopGatewayBypassHeaders } = require('../dist/agent/http-headers');
  const { pairDeviceWithGateway } = require('../dist/agent/pairing');
  const { getDefaultAgentSettings, saveAgentSettings } = require('../dist/agent/settings');

  try {
    await verifyPairingBearerToken(pairDeviceWithGateway);
    verifyVercelProtectionBypassHeaders(getDesktopGatewayBypassHeaders);

    saveAgentSettings({
      ...getDefaultAgentSettings(),
      displayName: 'Pairing Verifier',
      gatewayUrl: 'ws://127.0.0.1:1',
    });

    const service = new DesktopAgentService();
    for (const [label, input, expectedMessage] of [
      ['non-string ownerUserId', { ownerUserId: { id: 'forged-owner' }, pairingToken: 'proof' }, 'ownerUserId must be a string'],
      ['non-string pairingToken', { ownerUserId: 'pairing-owner', pairingToken: { token: 'proof' } }, 'pairingToken must be a string'],
      ['non-object pairing input', 123, 'Pairing input must be an ownerUserId string'],
      ['array pairing input', ['pairing-owner'], 'Pairing input must be an ownerUserId string'],
    ]) {
      let malformedInputRejected = false;
      try {
        await service.pairPersonalDevice(input);
      } catch (error) {
        malformedInputRejected = String(error instanceof Error ? error.message : error).includes(expectedMessage);
      }
      assert(malformedInputRejected, `${label} should be rejected before pairing`);
    }

    const statusAfterMalformedInput = await service.getStatus();
    assert(!statusAfterMalformedInput.deviceId, 'malformed pairing input should not persist a local deviceId');
    assert(!statusAfterMalformedInput.ownerUserId, 'malformed pairing input should not persist a local ownerUserId');

    let failedClosed = false;
    try {
      await service.pairPersonalDevice('pairing-owner');
    } catch (error) {
      failedClosed = String(error instanceof Error ? error.message : error).includes('Desktop pairing failed');
    }
    assert(failedClosed, 'pairing should fail closed when the gateway cannot issue a device token');

    const statusAfterFailure = await service.getStatus();
    assert(!statusAfterFailure.deviceId, 'failed pairing should not persist a local deviceId');
    assert(!statusAfterFailure.ownerUserId, 'failed pairing should not persist a local ownerUserId');

    const failedSettings = fs.readFileSync(process.env.CI_DESKTOP_AGENT_SETTINGS_PATH, 'utf-8');
    assert(!failedSettings.includes('pairing-owner'), 'failed pairing should not persist the requested owner');

    const audit = fs.existsSync(process.env.CI_DESKTOP_AGENT_AUDIT_PATH)
      ? fs.readFileSync(process.env.CI_DESKTOP_AGENT_AUDIT_PATH, 'utf-8')
      : '';
    assert(
      audit.includes('"tool":"desktop.pair"') &&
      audit.includes('"result":"denied"'),
      'failed gateway pairing should write a denied audit entry',
    );

    process.env.CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING = '1';
    process.env.CI_DESKTOP_AGENT_DISABLE_KEYCHAIN = '1';
    const keychainFailureService = new DesktopAgentService();
    let keychainFailedClosed = false;
    try {
      await keychainFailureService.pairPersonalDevice('keychain-owner');
    } catch (error) {
      keychainFailedClosed = String(error instanceof Error ? error.message : error).includes('device token could not be saved to Keychain');
    } finally {
      delete process.env.CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING;
      delete process.env.CI_DESKTOP_AGENT_DISABLE_KEYCHAIN;
    }
    assert(keychainFailedClosed, 'pairing should fail closed when the device token cannot be stored in Keychain');
    const statusAfterKeychainFailure = await keychainFailureService.getStatus();
    assert(!statusAfterKeychainFailure.deviceId, 'Keychain save failure should not persist a local deviceId');
    assert(!statusAfterKeychainFailure.ownerUserId, 'Keychain save failure should not persist a local ownerUserId');

    fs.writeFileSync(process.env.CI_DESKTOP_AGENT_SETTINGS_PATH, JSON.stringify({
      ...getDefaultAgentSettings(),
      enabled: true,
      deviceId: 'legacy-device',
      ownerUserId: 'legacy-owner',
      deviceToken: 'legacy-token-that-cannot-migrate',
    }, null, 2));
    process.env.CI_DESKTOP_AGENT_DISABLE_KEYCHAIN = '1';
    const legacyService = new DesktopAgentService();
    await legacyService.hydrateDeviceToken();
    delete process.env.CI_DESKTOP_AGENT_DISABLE_KEYCHAIN;
    const legacySettingsAfterFailedMigration = fs.readFileSync(process.env.CI_DESKTOP_AGENT_SETTINGS_PATH, 'utf-8');
    assert(
      legacySettingsAfterFailedMigration.includes('legacy-token-that-cannot-migrate'),
      'failed legacy token migration should not remove the only copy of the legacy token',
    );
    const statusAfterFailedMigration = await legacyService.getStatus();
    assert(
      statusAfterFailedMigration.deviceId === 'legacy-device' &&
      statusAfterFailedMigration.ownerUserId === 'legacy-owner',
      'failed legacy token migration should preserve paired identity for later retry',
    );

    process.env.CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING = '1';
    const offlineService = new DesktopAgentService();
    const offlineStatus = await offlineService.pairPersonalDevice('offline-owner');
    assert(offlineStatus.deviceId, 'explicit offline pairing should create a local deviceId for local verification');
    assert(offlineStatus.ownerUserId === 'offline-owner', 'explicit offline pairing should persist the requested owner');
    offlineService.disconnect();

    console.log('Pairing security verification passed');
  } finally {
    delete process.env.CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function verifyPairingBearerToken(pairDeviceWithGateway) {
  let requestBody = '';
  let authorization = '';
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization || '';
    request.on('data', (chunk) => {
      requestBody += chunk.toString();
    });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        deviceId: 'paired-device',
        deviceToken: 'paired-device-token',
        ownerUserId: 'pairing-owner',
      }));
    });
  });

  try {
    const port = await listen(server);
    const result = await pairDeviceWithGateway(`ws://127.0.0.1:${port}/desktop-agent/connect`, {
      ownerUserId: 'pairing-owner',
      displayName: 'Pairing Verifier',
      capabilities: { tools: [{ name: 'browser.open_url' }] },
      pairingToken: 'short-lived-pairing-proof',
    });

    assert(result.deviceId === 'paired-device', 'pairing client should parse deviceId from gateway response');
    assert(
      authorization === 'Bearer short-lived-pairing-proof',
      'pairing client should send pairing proof as a bearer token',
    );
    assert(
      !requestBody.includes('short-lived-pairing-proof') &&
      !Object.prototype.hasOwnProperty.call(JSON.parse(requestBody), 'pairingToken'),
      'pairing client should not serialize pairing proof into the JSON body',
    );
    assert(
      JSON.parse(requestBody).capabilities?.tools?.[0]?.name === 'browser.open_url',
      'pairing client should include desktop capability metadata in the JSON body',
    );
  } finally {
    await closeServer(server);
  }
}

function verifyVercelProtectionBypassHeaders(getDesktopGatewayBypassHeaders) {
  const previousSecret = process.env.CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET;
  const previousVercelSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const previousCookie = process.env.CI_DESKTOP_AGENT_VERCEL_SET_BYPASS_COOKIE;
  const previousHosts = process.env.CI_DESKTOP_AGENT_VERCEL_BYPASS_HOSTS;

  try {
    delete process.env.CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET;
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    delete process.env.CI_DESKTOP_AGENT_VERCEL_SET_BYPASS_COOKIE;
    delete process.env.CI_DESKTOP_AGENT_VERCEL_BYPASS_HOSTS;

    assert(
      Object.keys(getDesktopGatewayBypassHeaders('https://clients-preview.vercel.app')).length === 0,
      'Vercel bypass headers should be absent when no bypass secret is configured',
    );

    process.env.CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET = 'preview-bypass-secret';
    const vercelHeaders = getDesktopGatewayBypassHeaders('https://clients-preview.vercel.app');
    assert(
      vercelHeaders['x-vercel-protection-bypass'] === 'preview-bypass-secret',
      'Vercel preview hosts should receive the configured protection bypass header',
    );
    assert(
      !vercelHeaders['x-vercel-set-bypass-cookie'],
      'desktop HTTP requests should not set a bypass cookie unless explicitly configured',
    );

    process.env.CI_DESKTOP_AGENT_VERCEL_SET_BYPASS_COOKIE = 'samesitenone';
    const cookieHeaders = getDesktopGatewayBypassHeaders('https://clients-preview.vercel.app');
    assert(
      cookieHeaders['x-vercel-set-bypass-cookie'] === 'samesitenone',
      'optional Vercel bypass cookie mode should be forwarded when explicitly configured',
    );

    assert(
      Object.keys(getDesktopGatewayBypassHeaders('https://clientintelligence.ai')).length === 0,
      'Vercel bypass secret should not be sent to production app hosts by default',
    );
    assert(
      Object.keys(getDesktopGatewayBypassHeaders('https://vercel.app.evil.test')).length === 0,
      'Vercel bypass host matching should reject lookalike domains',
    );

    process.env.CI_DESKTOP_AGENT_VERCEL_BYPASS_HOSTS = 'preview.clientintelligence.test';
    const allowlistedHeaders = getDesktopGatewayBypassHeaders('https://preview.clientintelligence.test');
    assert(
      allowlistedHeaders['x-vercel-protection-bypass'] === 'preview-bypass-secret',
      'explicit preview bypass host allowlist should permit custom preview hosts',
    );
  } finally {
    restoreEnv('CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET', previousSecret);
    restoreEnv('VERCEL_AUTOMATION_BYPASS_SECRET', previousVercelSecret);
    restoreEnv('CI_DESKTOP_AGENT_VERCEL_SET_BYPASS_COOKIE', previousCookie);
    restoreEnv('CI_DESKTOP_AGENT_VERCEL_BYPASS_HOSTS', previousHosts);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
