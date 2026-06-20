#!/usr/bin/env node

const {
  getCapabilityManifest,
  getCapabilityNames,
  validateCapabilityInput,
} = require('../dist/agent/capabilities');

const manifest = getCapabilityManifest();
const names = getCapabilityNames();

assert(manifest.length > 0, 'capability manifest should not be empty');
assert(names.length === manifest.length, 'capability names should match manifest length');

const manifestNames = new Set();
for (const capability of manifest) {
  assert(capability.name, 'capability should have a name');
  assert(!manifestNames.has(capability.name), `duplicate capability: ${capability.name}`);
  manifestNames.add(capability.name);
  assert(capability.description, `${capability.name} should have a description`);
  assert(['low', 'medium', 'high'].includes(capability.risk), `${capability.name} should have a valid risk`);
  assert(Array.isArray(capability.requiredMacPermissions), `${capability.name} should list macOS permissions`);
  assert(typeof capability.requiresApproval === 'boolean', `${capability.name} should declare approval requirement`);
  assert(typeof capability.canRunUnattended === 'boolean', `${capability.name} should declare unattended behavior`);
  assert(capability.inputSchema && typeof capability.inputSchema === 'object', `${capability.name} should have input schema`);
  assert(capability.outputSchema && typeof capability.outputSchema === 'object', `${capability.name} should have output schema`);
  assert(capability.outputSchema.type === 'object', `${capability.name} output schema should be an object schema`);
}

for (const name of names) {
  assert(manifestNames.has(name), `${name} should exist in manifest`);
}

assert(manifestNames.has('screen.stream'), 'manifest should include screen.stream');
assert(manifestNames.has('screen.sources'), 'manifest should include screen.sources');
assert(manifestNames.has('input.click'), 'manifest should include input.click');
assert(manifestNames.has('input.drag'), 'manifest should include input.drag');
assert(manifestNames.has('input.scroll'), 'manifest should include input.scroll');
assert(manifestNames.has('input.press_key'), 'manifest should include input.press_key');
assert(manifestNames.has('clipboard.read_text'), 'manifest should include clipboard.read_text');
assert(manifestNames.has('clipboard.write_text'), 'manifest should include clipboard.write_text');
assert(manifestNames.has('apps.list'), 'manifest should include apps.list');
assert(manifestNames.has('apps.frontmost'), 'manifest should include apps.frontmost');
assert(manifestNames.has('apps.quit'), 'manifest should include apps.quit');
assert(manifestNames.has('system.info'), 'manifest should include system.info');
assert(manifestNames.has('system.storage'), 'manifest should include system.storage');
assert(manifestNames.has('system.network'), 'manifest should include system.network');
assert(manifestNames.has('files.stat'), 'manifest should include files.stat');
assert(manifestNames.has('files.tail'), 'manifest should include files.tail');
assert(manifestNames.has('files.watch'), 'manifest should include files.watch');
assert(manifestNames.has('files.read_binary'), 'manifest should include files.read_binary');
assert(manifestNames.has('files.write_binary'), 'manifest should include files.write_binary');
assert(manifestNames.has('files.mkdir'), 'manifest should include files.mkdir');
assert(manifestNames.has('files.copy'), 'manifest should include files.copy');
assert(manifestNames.has('files.move'), 'manifest should include files.move');
assert(manifestNames.has('files.delete'), 'manifest should include files.delete');
assert(manifestNames.has('files.open'), 'manifest should include files.open');
assert(manifestNames.has('files.reveal'), 'manifest should include files.reveal');
assert(manifestNames.has('automation.applescript'), 'manifest should include automation.applescript');
assert(manifestNames.has('agent.request_secret'), 'manifest should include agent.request_secret');
assert(manifestNames.has('secrets.save'), 'manifest should include secrets.save');
assert(manifestNames.has('secrets.exists'), 'manifest should include secrets.exists');
assert(manifestNames.has('secrets.delete'), 'manifest should include secrets.delete');
assert(manifestNames.has('secrets.fill_focused_field'), 'manifest should include secrets.fill_focused_field');

assert(validateCapabilityInput('input.click', { x: 10, y: 20 }).ok, 'valid input.click args should pass validation');
assert(validateCapabilityInput('input.click', { x: 10, y: 20, button: 'right', clickCount: 2 }).ok, 'valid input.click button args should pass validation');
assert(validateCapabilityInput('input.click', { x: 10, y: 20, expectedFrontmostApp: 'Google Chrome' }).ok, 'valid guarded input.click args should pass validation');
assert(!validateCapabilityInput('input.click', { x: 10 }).ok, 'missing input.click coordinate should fail validation');
assert(!validateCapabilityInput('input.click', { x: 10, y: '20' }).ok, 'wrong input.click coordinate type should fail validation');
assert(!validateCapabilityInput('input.click', { x: 10, y: 20, z: 30 }).ok, 'unknown input.click arg should fail validation');
assert(!validateCapabilityInput('input.click', { x: 10, y: 20, clickCount: '2' }).ok, 'wrong input.click clickCount type should fail validation');
assert(!validateCapabilityInput('input.click', { x: 10, y: 20, expectedFrontmostApp: 42 }).ok, 'wrong input.click expected app type should fail validation');
assert(validateCapabilityInput('input.drag', { fromX: 10, fromY: 20, toX: 30, toY: 40 }).ok, 'valid input.drag args should pass validation');
assert(validateCapabilityInput('input.drag', { fromX: 10, fromY: 20, toX: 30, toY: 40, durationMs: 250 }).ok, 'valid input.drag duration args should pass validation');
assert(validateCapabilityInput('input.drag', { fromX: 10, fromY: 20, toX: 30, toY: 40, expectedFrontmostApp: 'Safari' }).ok, 'valid guarded input.drag args should pass validation');
assert(!validateCapabilityInput('input.drag', { fromX: 10, fromY: 20, toX: 30 }).ok, 'missing input.drag coordinate should fail validation');
assert(!validateCapabilityInput('input.drag', { fromX: 10, fromY: 20, toX: 30, toY: '40' }).ok, 'wrong input.drag coordinate type should fail validation');
assert(validateCapabilityInput('input.scroll', { deltaY: -900 }).ok, 'valid input.scroll args should pass validation');
assert(validateCapabilityInput('input.scroll', { deltaY: -900, deltaX: 0, x: 800, y: 500 }).ok, 'valid input.scroll coordinate args should pass validation');
assert(validateCapabilityInput('input.scroll', { deltaY: -900, expectedFrontmostApp: 'Arc' }).ok, 'valid guarded input.scroll args should pass validation');
assert(!validateCapabilityInput('input.scroll', {}).ok, 'missing input.scroll deltaY should fail validation');
assert(!validateCapabilityInput('input.scroll', { deltaY: '-900' }).ok, 'wrong input.scroll deltaY type should fail validation');
assert(validateCapabilityInput('input.press_key', { key: 'return' }).ok, 'valid input.press_key args should pass validation');
assert(validateCapabilityInput('input.press_key', { key: 'tab', modifiers: ['shift'] }).ok, 'valid input.press_key modifier args should pass validation');
assert(validateCapabilityInput('input.press_key', { key: 'return', expectedFrontmostApp: 'Finder' }).ok, 'valid guarded input.press_key args should pass validation');
assert(!validateCapabilityInput('input.press_key', {}).ok, 'missing input.press_key key should fail validation');
assert(!validateCapabilityInput('input.press_key', { key: 'return', modifiers: 'shift' }).ok, 'wrong input.press_key modifiers type should fail validation');
assert(validateCapabilityInput('input.type_text', { text: 'hello', expectedFrontmostApp: 'Google Chrome' }).ok, 'valid guarded input.type_text args should pass validation');
assert(validateCapabilityInput('input.hotkey', { key: 'l', modifiers: ['command'], expectedFrontmostApp: 'Google Chrome' }).ok, 'valid guarded input.hotkey args should pass validation');
assert(validateCapabilityInput('clipboard.read_text', {}).ok, 'valid clipboard.read_text args should pass validation');
assert(validateCapabilityInput('clipboard.write_text', { text: 'copy this' }).ok, 'valid clipboard.write_text args should pass validation');
assert(!validateCapabilityInput('clipboard.write_text', {}).ok, 'missing clipboard.write_text text should fail validation');
assert(validateCapabilityInput('apps.list', {}).ok, 'valid apps.list args should pass validation');
assert(validateCapabilityInput('apps.frontmost', {}).ok, 'valid apps.frontmost args should pass validation');
assert(validateCapabilityInput('apps.open', { name: 'TextEdit' }).ok, 'valid apps.open name args should pass validation');
assert(validateCapabilityInput('apps.activate', { name: 'Google Chrome' }).ok, 'valid apps.activate name args should pass validation');
assert(!validateCapabilityInput('apps.activate', { name: 123 }).ok, 'wrong apps.activate name type should fail validation');
assert(validateCapabilityInput('apps.quit', { name: 'TextEdit' }).ok, 'valid apps.quit name args should pass validation');
assert(validateCapabilityInput('apps.quit', { pid: 123 }).ok, 'valid apps.quit pid args should pass validation');
assert(!validateCapabilityInput('apps.quit', { pid: '123' }).ok, 'wrong apps.quit pid type should fail validation');
assert(validateCapabilityInput('system.info', {}).ok, 'valid system.info args should pass validation');
assert(validateCapabilityInput('system.storage', { path: '/' }).ok, 'valid system.storage args should pass validation');
assert(!validateCapabilityInput('system.storage', { path: 42 }).ok, 'wrong system.storage path type should fail validation');
assert(validateCapabilityInput('system.network', {}).ok, 'valid system.network args should pass validation');
assert(validateCapabilityInput('system.network', { includeInternal: true }).ok, 'valid system.network includeInternal args should pass validation');
assert(!validateCapabilityInput('system.network', { includeInternal: 'yes' }).ok, 'wrong system.network includeInternal type should fail validation');
assert(validateCapabilityInput('screen.sources', {}).ok, 'valid screen.sources args should pass validation');
assert(validateCapabilityInput('screen.sources', { includeWindows: true }).ok, 'valid screen.sources includeWindows args should pass validation');
assert(!validateCapabilityInput('screen.sources', { includeWindows: 'yes' }).ok, 'wrong screen.sources includeWindows type should fail validation');
assert(validateCapabilityInput('screen.screenshot', { sourceId: 'window:123', width: 1200, height: 800 }).ok, 'valid source-targeted screen.screenshot args should pass validation');
assert(validateCapabilityInput('screen.screenshot', { format: 'jpeg', quality: 70 }).ok, 'valid jpeg screen.screenshot args should pass validation');
assert(!validateCapabilityInput('screen.screenshot', { width: '1200' }).ok, 'wrong screen.screenshot width type should fail validation');
assert(!validateCapabilityInput('screen.screenshot', { quality: '70' }).ok, 'wrong screen.screenshot quality type should fail validation');
assert(validateCapabilityInput('screen.stream', { sourceId: 'window:123', durationMs: 2000, intervalMs: 1000 }).ok, 'valid source-targeted screen.stream args should pass validation');
assert(validateCapabilityInput('screen.stream', { format: 'jpeg', quality: 60, durationMs: 2000, intervalMs: 1000 }).ok, 'valid jpeg screen.stream args should pass validation');
assert(!validateCapabilityInput('screen.stream', { sourceId: 123 }).ok, 'wrong screen.stream sourceId type should fail validation');
assert(validateCapabilityInput('secrets.save', { name: 'test', secret: 'value' }).ok, 'valid secrets.save args should pass validation');
assert(!validateCapabilityInput('secrets.save', { name: 'test' }).ok, 'missing secrets.save secret should fail validation');
assert(!validateCapabilityInput('secrets.exists', { name: 123 }).ok, 'wrong secrets.exists name type should fail validation');
assert(validateCapabilityInput('files.copy', { sourcePath: '/tmp/a', destinationPath: '/tmp/b' }).ok, 'valid files.copy args should pass validation');
assert(!validateCapabilityInput('files.copy', { sourcePath: '/tmp/a' }).ok, 'missing files.copy destination should fail validation');
assert(validateCapabilityInput('files.tail', { path: '/tmp/a', lines: 10 }).ok, 'valid files.tail args should pass validation');
assert(!validateCapabilityInput('files.tail', { path: '/tmp/a', lines: '10' }).ok, 'wrong files.tail line type should fail validation');
assert(validateCapabilityInput('files.watch', { path: '/tmp/a', recursive: true, durationMs: 1000 }).ok, 'valid files.watch args should pass validation');
assert(!validateCapabilityInput('files.watch', { path: '/tmp/a', recursive: 'yes' }).ok, 'wrong files.watch recursive type should fail validation');
assert(validateCapabilityInput('files.delete', { path: '/tmp/a', recursive: true }).ok, 'valid files.delete args should pass validation');
assert(!validateCapabilityInput('files.delete', { path: '/tmp/a', recursive: 'yes' }).ok, 'wrong files.delete recursive type should fail validation');
assert(validateCapabilityInput('files.open', { path: '/tmp/a' }).ok, 'valid files.open args should pass validation');
assert(!validateCapabilityInput('files.open', {}).ok, 'missing files.open path should fail validation');
assert(validateCapabilityInput('files.reveal', { path: '/tmp/a' }).ok, 'valid files.reveal args should pass validation');
assert(!validateCapabilityInput('files.reveal', { path: 42 }).ok, 'wrong files.reveal path type should fail validation');
assert(validateCapabilityInput('browser.open_url', { url: 'https://clientintelligence.ai' }).ok, 'valid browser URL should pass validation');
assert(validateCapabilityInput('browser.open_url', { url: 'https://clientintelligence.ai', browser: 'chrome' }).ok, 'valid targeted browser URL should pass validation');
assert(!validateCapabilityInput('browser.open_url', { url: 'file:///etc/passwd' }).ok, 'non-http URL should fail validation');
assert(!validateCapabilityInput('browser.open_url', { url: 'https://clientintelligence.ai', browser: 42 }).ok, 'wrong browser target type should fail validation');
assert(!validateCapabilityInput('nope.missing', {}).ok, 'unknown capability should fail validation');

const appActivateCapability = manifest.find((capability) => capability.name === 'apps.activate');
assert(appActivateCapability?.requiresApproval === true, 'apps.activate should require approval because it changes the input target app');
assert(appActivateCapability?.canRunUnattended === false, 'apps.activate should not run unattended');

const screenshotCapability = manifest.find((capability) => capability.name === 'screen.screenshot');
assert(
  screenshotCapability?.outputSchema?.properties?.data?.type === 'string' &&
  screenshotCapability?.outputSchema?.properties?.mimeType?.type === 'string',
  'screen.screenshot output schema should describe screenshot image payload fields',
);

const streamCapability = manifest.find((capability) => capability.name === 'screen.stream');
assert(
  streamCapability?.outputSchema?.properties?.framesSent?.type === 'number',
  'screen.stream output schema should describe stream summary fields',
);

const fileReadCapability = manifest.find((capability) => capability.name === 'files.read');
assert(
  fileReadCapability?.outputSchema?.properties?.content?.type === 'string',
  'files.read output schema should describe readable content',
);

const secretPromptCapability = manifest.find((capability) => capability.name === 'agent.request_secret');
assert(
  secretPromptCapability?.outputSchema?.properties?.secret?.const === '[redacted]',
  'agent.request_secret output schema should document redacted secret responses',
);

console.log('Capability manifest verification passed');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
