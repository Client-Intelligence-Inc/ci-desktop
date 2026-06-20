#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const packageJson = readJson(path.join(root, 'package.json'));
const buildConfig = packageJson.build || {};
const macConfig = buildConfig.mac || {};
const extendInfo = macConfig.extendInfo || {};
const scripts = packageJson.scripts || {};
const buildScriptPath = path.join(root, 'scripts/build-mac.sh');
const entitlementsPath = path.join(root, macConfig.entitlements || '');
const entitlementsInheritPath = path.join(root, macConfig.entitlementsInherit || '');
const buildScript = fs.readFileSync(buildScriptPath, 'utf-8');
const entitlements = fs.readFileSync(entitlementsPath, 'utf-8');
const mainSource = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf-8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
const stagingRunbookPath = path.join(root, 'docs/staging-preview-runbook.md');
const stagingRunbook = fs.readFileSync(stagingRunbookPath, 'utf-8');

assert(buildConfig.appId === 'ai.clientintelligence.desktop', 'mac package appId should remain stable');
assert(buildConfig.productName === 'Client Intelligence', 'mac package productName should remain stable');
assert(Array.isArray(buildConfig.files), 'electron-builder files list should exist');
assert(buildConfig.files.includes('dist/**/*'), 'electron-builder package should include compiled dist files');
assert(buildConfig.files.includes('build/**/*'), 'electron-builder package should include build assets');

assert(macConfig.hardenedRuntime === true, 'mac hardenedRuntime must stay enabled');
assert(macConfig.notarize === true, 'mac notarization must stay enabled');
assert(macConfig.entitlements === 'build/entitlements.mac.plist', 'mac entitlements path should be configured');
assert(macConfig.entitlementsInherit === 'build/entitlements.mac.plist', 'mac inherited entitlements path should be configured');
assert(fs.existsSync(entitlementsPath), 'mac entitlements file should exist');
assert(fs.existsSync(entitlementsInheritPath), 'mac inherited entitlements file should exist');
assert(macConfig.icon === 'build/icon.icns', 'mac release icon should be configured');

assert(
  typeof extendInfo.NSAppleEventsUsageDescription === 'string' &&
  extendInfo.NSAppleEventsUsageDescription.length > 20,
  'Apple Events usage string should explain app automation access',
);
assert(
  typeof extendInfo.NSAccessibilityUsageDescription === 'string' &&
  extendInfo.NSAccessibilityUsageDescription.length > 20,
  'Accessibility usage string should explain keyboard and mouse control access',
);
assert(
  typeof extendInfo.NSScreenCaptureUsageDescription === 'string' &&
  extendInfo.NSScreenCaptureUsageDescription.length > 20,
  'Screen Capture usage string should explain screenshot access',
);
assert(
  extendInfo.NSAppTransportSecurity?.NSAllowsArbitraryLoads === false,
  'ATS arbitrary loads should remain disabled',
);
assert(
  extendInfo.NSAppTransportSecurity?.NSAllowsLocalNetworking === true,
  'ATS local networking should remain enabled for mock gateway/dev flows',
);

assert(entitlements.includes('com.apple.security.network.client'), 'entitlements should allow outbound gateway connections');
assert(
  entitlements.includes('com.apple.security.files.user-selected.read-write'),
  'entitlements should allow user-selected scoped file access',
);

assert(scripts.dist === 'scripts/build-mac.sh', 'dist script should use guarded mac build script');
assert(
  scripts['dist:publish'] === 'scripts/build-mac.sh --publish always',
  'dist:publish script should use guarded mac build script',
);
assert(buildScript.includes('Developer ID Application'), 'mac build should require Developer ID Application signing');
assert(buildScript.includes('resolve_developer_id_identity'), 'mac build should resolve a local Developer ID identity');
assert(buildScript.includes('unset APPLE_ID'), 'mac build should avoid mixed notarization credential modes');
assert(buildScript.includes('rm -rf release/mac-universal'), 'mac build should remove stale unsigned app artifacts');
assert(buildScript.includes('codesign --verify --deep --strict'), 'mac build should verify code signing after build');
assert(
  buildScript.includes('Authority=Developer ID Application:'),
  'mac build should verify Developer ID signing authority after build',
);
assert(
  mainSource.includes('notifyRemoteControlState') &&
  mainSource.includes('Remote control active') &&
  mainSource.includes('Client Intelligence remote control active'),
  'desktop shell should keep a visible local active-control indicator',
);
assert(
  occurrences(mainSource, "openPermissionSettings('automation')") >= 2 &&
  mainSource.includes('Open Automation Settings'),
  'desktop shell should expose Automation permission shortcuts in native menus',
);
assert(
  readme.includes('docs/staging-preview-runbook.md'),
  'README should link the staging preview runbook',
);
assert(
  stagingRunbook.includes('CI_DESKTOP_AGENT_GATEWAY_URL=<preview-url>') &&
  stagingRunbook.includes('CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET=<Protection Bypass for Automation secret>'),
  'staging runbook should document preview gateway and Vercel bypass launch env',
);
assert(
  stagingRunbook.includes('npm run verify:desktop-agent:local-e2e') &&
  stagingRunbook.includes('Phone-Width Chat Checks'),
  'staging runbook should document final E2E and phone chat checks',
);

console.log('Packaging configuration verification passed');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}
