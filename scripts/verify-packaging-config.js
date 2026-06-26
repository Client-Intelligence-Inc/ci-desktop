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
const buildWorkflowPath = path.join(root, '.github/workflows/build.yml');
const entitlementsPath = path.join(root, macConfig.entitlements || '');
const entitlementsInheritPath = path.join(root, macConfig.entitlementsInherit || '');
const buildScript = fs.readFileSync(buildScriptPath, 'utf-8');
const buildWorkflow = fs.readFileSync(buildWorkflowPath, 'utf-8');
const entitlements = fs.readFileSync(entitlementsPath, 'utf-8');
const mainSource = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf-8');
const agentIpcSource = fs.readFileSync(path.join(root, 'src/agent/ipc.ts'), 'utf-8');
const preloadSource = fs.readFileSync(path.join(root, 'src/preload.ts'), 'utf-8');
const agentControlSource = fs.readFileSync(path.join(root, 'src/agent-control.html'), 'utf-8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
const stagingRunbookPath = path.join(root, 'docs/staging-preview-runbook.md');
const stagingRunbook = fs.readFileSync(stagingRunbookPath, 'utf-8');

assert(buildConfig.appId === 'ai.clientintelligence.desktop', 'mac package appId should remain stable');
assert(buildConfig.productName === 'Client Intelligence', 'mac package productName should remain stable');
assert(Array.isArray(buildConfig.files), 'electron-builder files list should exist');
assert(buildConfig.files.includes('dist/**/*'), 'electron-builder package should include compiled dist files');
assert(buildConfig.files.includes('build/**/*'), 'electron-builder package should include build assets');
assert(
  buildConfig.files.includes('src/agent-control.html'),
  'electron-builder package should include local Agent Control Center UI',
);

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
  typeof extendInfo.NSMicrophoneUsageDescription === 'string' &&
  extendInfo.NSMicrophoneUsageDescription.length > 20,
  'Microphone usage string should explain voice mode access',
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
assert(
  buildScript.includes('${developer_id_identity#Developer ID Application: }'),
  'mac build should pass electron-builder an unprefixed Developer ID certificate name',
);
assert(
  buildScript.includes('CSC_LINK') &&
  buildScript.includes('Using CSC_LINK signing certificate') &&
  buildScript.includes('Developer ID authority will be verified after build'),
  'mac build should support CI CSC_LINK signing mode while still verifying Developer ID authority after build',
);
assert(
  buildScript.includes('run_notarization_preflight') &&
  buildScript.includes('xcrun notarytool history') &&
  buildScript.includes('CI_DESKTOP_SKIP_NOTARIZATION_PREFLIGHT') &&
  buildScript.includes('missing or expired agreement'),
  'mac build should fail fast on missing notarization credentials or Apple Developer agreements',
);
assert(buildScript.includes('unset APPLE_ID'), 'mac build should avoid mixed notarization credential modes');
assert(buildScript.includes('rm -rf release/mac-universal'), 'mac build should remove stale unsigned app artifacts');
assert(buildScript.includes('codesign --verify --deep --strict'), 'mac build should verify code signing after build');
assert(
  buildScript.includes('Authority=Developer ID Application:'),
  'mac build should verify Developer ID signing authority after build',
);
assert(
  buildScript.includes('spctl -a -vvv -t execute') &&
  buildScript.includes('source=Notarized Developer ID'),
  'mac build should verify the app passes Gatekeeper as a notarized Developer ID app after build',
);
assert(
  buildWorkflow.includes('run: npm run dist') &&
  buildWorkflow.includes('run: npm run dist:publish') &&
  !buildWorkflow.includes('run: npx electron-builder --mac'),
  'GitHub Actions release workflow should use the guarded mac build scripts',
);
assert(
  mainSource.includes('notifyRemoteControlState') &&
  mainSource.includes('Remote control active') &&
  mainSource.includes('Client Intelligence remote control active'),
  'desktop shell should keep a visible local active-control indicator',
);
assert(
  mainSource.includes('Open Agent Control Center') &&
  mainSource.includes('loadFile(controlPath)') &&
  mainSource.includes('initAgentIpc(desktopAgent, isTrustedAgentIpcOrigin, openAgentControlCenter)'),
  'desktop shell should expose the local Agent Control Center through native UI',
);
assert(
  mainSource.includes('function isLocalAgentControlURL') &&
  mainSource.includes('function isTrustedAgentIpcOrigin') &&
  mainSource.includes('isTrustedPermissionOrigin(url) || isLocalAgentControlURL(url)'),
  'local Agent Control Center should be the only repo-local file origin trusted for agent IPC',
);
assert(
  mainSource.includes('ALLOWED_APP_PERMISSIONS') &&
  mainSource.includes("'media'") &&
  mainSource.includes('callback(ALLOWED_APP_PERMISSIONS.has(permission) && isTrustedPermissionOrigin(requestUrl))') &&
  mainSource.includes('return ALLOWED_APP_PERMISSIONS.has(permission) && isTrustedPermissionOrigin(requestUrl)'),
  'microphone/media permission handling should remain limited to trusted app origins',
);
assert(
  preloadSource.includes('runLocalDesktopJob') &&
  preloadSource.includes('respondToLocalDesktopPrompt') &&
  preloadSource.includes('cancelLocalDesktopJob'),
  'trusted preload bridge should expose structured local desktop-job controls',
);
assert(
  preloadSource.includes('openAgentControlCenter') &&
  mainSource.includes('initAgentIpc(desktopAgent, isTrustedAgentIpcOrigin, openAgentControlCenter)') &&
  agentIpcSource.includes("ipcMain.handle('agent:open-control-center'"),
  'trusted preload bridge should expose origin-checked Agent Control Center opening',
);
assert(
  preloadSource.includes('getSupportBundle') &&
  agentIpcSource.includes("ipcMain.handle('agent:get-support-bundle'") &&
  agentControlSource.includes('copyDiagnosticsButton') &&
  agentControlSource.includes('Copy diagnostics'),
  'trusted bridge and Agent Control Center should expose redacted diagnostics bundle collection',
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
