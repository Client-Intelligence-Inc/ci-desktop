import { appendAuditEntry } from './audit';
import { DesktopAgentSettings, DesktopCapability, ToolRequest, ToolResult } from './types';
import { runAutomationTool } from '../tools/automation';
import { runAppTool } from '../tools/apps';
import { runBrowserTool } from '../tools/browser';
import { runClipboardTool } from '../tools/clipboard';
import { runFileTool } from '../tools/files';
import { runInputTool } from '../tools/input';
import { runSecretTool } from '../tools/secrets';
import { runScreenTool } from '../tools/screen';
import { runShellTool } from '../tools/shell';
import { runSystemTool } from '../tools/system';
import { validateInputSchema, ValidationResult } from './schema';

export type ToolRunner = (request: ToolRequest, settings: DesktopAgentSettings) => Promise<ToolResult>;

const runners: Record<string, ToolRunner> = {
  'browser.open_url': runBrowserTool,
  'clipboard.read_text': runClipboardTool,
  'clipboard.write_text': runClipboardTool,
  'apps.list': runAppTool,
  'apps.frontmost': runAppTool,
  'apps.open': runAppTool,
  'apps.activate': runAppTool,
  'apps.quit': runAppTool,
  'files.stat': runFileTool,
  'files.list': runFileTool,
  'files.search': runFileTool,
  'files.read': runFileTool,
  'files.tail': runFileTool,
  'files.watch': async () => ({ ok: false, error: 'files.watch must run through the agent connection stream handler' }),
  'files.write': runFileTool,
  'files.read_binary': runFileTool,
  'files.write_binary': runFileTool,
  'files.mkdir': runFileTool,
  'files.copy': runFileTool,
  'files.move': runFileTool,
  'files.delete': runFileTool,
  'files.open': runFileTool,
  'files.reveal': runFileTool,
  'screen.sources': runScreenTool,
  'screen.screenshot': runScreenTool,
  'input.click': runInputTool,
  'input.drag': runInputTool,
  'input.scroll': runInputTool,
  'input.type_text': runInputTool,
  'input.hotkey': runInputTool,
  'input.press_key': runInputTool,
  'secrets.save': runSecretTool,
  'secrets.exists': runSecretTool,
  'secrets.delete': runSecretTool,
  'secrets.fill_focused_field': runSecretTool,
  'automation.applescript': runAutomationTool,
  'shell.run': runShellTool,
  'system.info': runSystemTool,
  'system.storage': runSystemTool,
  'system.network': runSystemTool,
};

export function getCapabilityNames(): string[] {
  return getCapabilityManifest().map((capability) => capability.name);
}

export function getCapabilityManifest(): DesktopCapability[] {
  return [
    capability('browser.open_url', 'Open an http or https URL in the default browser.', 'low', [], false, true, {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        browser: { type: 'string' },
      },
    }),
    capability('clipboard.read_text', 'Read text from the Mac clipboard.', 'high', [], true, false, {
      type: 'object',
      properties: {},
    }),
    capability('clipboard.write_text', 'Write text to the Mac clipboard.', 'high', [], true, false, {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
    }),
    capability('apps.open', 'Open a local macOS application by name or path.', 'low', [], false, true, {
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string' } },
    }),
    capability('apps.activate', 'Bring a local macOS application forward before remote input.', 'high', ['accessibility'], true, false, {
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string' } },
    }),
    capability('apps.list', 'List running local processes visible to the desktop agent.', 'medium', [], false, true, {
      type: 'object',
      properties: {},
    }),
    capability('apps.frontmost', 'Inspect the current frontmost macOS app and active window title.', 'medium', ['accessibility'], false, true, {
      type: 'object',
      properties: {},
    }),
    capability('apps.quit', 'Quit a local app by name, path, or process ID.', 'high', ['automation'], true, false, {
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string' }, pid: { type: 'number' } },
    }),
    capability('system.info', 'Inspect basic Mac system, CPU, memory, and uptime information.', 'low', [], false, true, {
      type: 'object',
      properties: {},
    }),
    capability('system.storage', 'Inspect mounted volume storage capacity.', 'low', [], false, true, {
      type: 'object',
      properties: { path: { type: 'string' } },
    }),
    capability('system.network', 'Inspect local network interfaces and addresses.', 'low', [], false, true, {
      type: 'object',
      properties: { includeInternal: { type: 'boolean' } },
    }),
    capability('files.stat', 'Inspect file or folder metadata inside allowed scope.', 'low', ['full_disk_access'], false, true, filePathSchema()),
    capability('files.list', 'List files inside an allowed folder or full-disk scope.', 'medium', ['full_disk_access'], false, true, filePathSchema()),
    capability('files.search', 'Search file names and optionally readable text content inside allowed scope.', 'medium', ['full_disk_access'], false, true, {
      type: 'object',
      required: ['query'],
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        includeContent: { type: 'boolean' },
        limit: { type: 'number' },
      },
    }),
    capability('files.read', 'Read a file inside allowed scope.', 'medium', ['full_disk_access'], false, true, filePathSchema()),
    capability('files.tail', 'Read the last lines or bytes of a scoped file.', 'medium', ['full_disk_access'], false, true, {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        lines: { type: 'number' },
        bytes: { type: 'number' },
        encoding: { type: 'string' },
      },
    }),
    capability('files.watch', 'Watch a scoped file or folder and stream create, modify, and delete events.', 'medium', ['full_disk_access'], true, false, {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
        intervalMs: { type: 'number' },
        durationMs: { type: 'number' },
        maxEvents: { type: 'number' },
      },
    }),
    capability('files.write', 'Write a file inside allowed scope.', 'high', ['full_disk_access'], true, false, {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    }),
    capability('files.read_binary', 'Read a binary file as base64 inside allowed scope.', 'medium', ['full_disk_access'], false, true, filePathSchema()),
    capability('files.write_binary', 'Write base64 binary content to a file inside allowed scope.', 'high', ['full_disk_access'], true, false, {
      type: 'object',
      required: ['path', 'contentBase64'],
      properties: { path: { type: 'string' }, contentBase64: { type: 'string' } },
    }),
    capability('files.mkdir', 'Create a directory inside allowed scope.', 'high', ['full_disk_access'], true, false, filePathSchema()),
    capability('files.copy', 'Copy a file or directory inside allowed scope.', 'high', ['full_disk_access'], true, false, {
      type: 'object',
      required: ['sourcePath', 'destinationPath'],
      properties: {
        sourcePath: { type: 'string' },
        destinationPath: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
    }),
    capability('files.move', 'Move or rename a file or directory inside allowed scope.', 'high', ['full_disk_access'], true, false, {
      type: 'object',
      required: ['sourcePath', 'destinationPath'],
      properties: {
        sourcePath: { type: 'string' },
        destinationPath: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
    }),
    capability('files.delete', 'Delete a file or explicitly recursive directory inside allowed scope.', 'high', ['full_disk_access'], true, false, {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
    }),
    capability('files.open', 'Open a scoped local file or folder on the Mac.', 'high', ['full_disk_access'], true, false, filePathSchema()),
    capability('files.reveal', 'Reveal a scoped local file or folder in Finder.', 'medium', ['full_disk_access'], true, false, filePathSchema()),
    capability('screen.sources', 'List available screen and optional window capture sources without image data.', 'medium', ['screen_recording'], false, true, {
      type: 'object',
      properties: { includeWindows: { type: 'boolean' } },
    }),
    capability('screen.screenshot', 'Capture a screenshot and send it to chat.', 'high', ['screen_recording'], true, false, {
      type: 'object',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        sourceId: { type: 'string' },
        format: { type: 'string' },
        quality: { type: 'number' },
      },
    }),
    capability('screen.stream', 'Send repeated screenshots until duration, frame limit, or cancellation.', 'high', ['screen_recording'], true, false, {
      type: 'object',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        sourceId: { type: 'string' },
        format: { type: 'string' },
        quality: { type: 'number' },
        intervalMs: { type: 'number' },
        durationMs: { type: 'number' },
        maxFrames: { type: 'number' },
      },
    }),
    capability('input.click', 'Click a screen coordinate.', 'high', ['accessibility'], true, false, {
      type: 'object',
      required: ['x', 'y'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string' },
        clickCount: { type: 'number' },
        expectedFrontmostApp: { type: 'string' },
      },
    }),
    capability('input.drag', 'Drag from one screen coordinate to another.', 'high', ['accessibility'], true, false, {
      type: 'object',
      required: ['fromX', 'fromY', 'toX', 'toY'],
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        durationMs: { type: 'number' },
        expectedFrontmostApp: { type: 'string' },
      },
    }),
    capability('input.scroll', 'Scroll the focused app or a screen coordinate.', 'high', ['accessibility'], true, false, {
      type: 'object',
      required: ['deltaY'],
      properties: {
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
        expectedFrontmostApp: { type: 'string' },
      },
    }),
    capability('input.type_text', 'Type text into the focused app.', 'high', ['accessibility'], true, false, {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' }, expectedFrontmostApp: { type: 'string' } },
    }),
    capability('input.hotkey', 'Send a keyboard shortcut to the focused app.', 'high', ['accessibility'], true, false, {
      type: 'object',
      required: ['key'],
      properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, expectedFrontmostApp: { type: 'string' } },
    }),
    capability('input.press_key', 'Press a special keyboard key such as Return, Escape, Tab, arrows, Delete, or function keys.', 'high', ['accessibility'], true, false, {
      type: 'object',
      required: ['key'],
      properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } }, expectedFrontmostApp: { type: 'string' } },
    }),
    capability('secrets.save', 'Store a named secret in macOS Keychain without writing it to local settings.', 'high', [], true, false, {
      type: 'object',
      required: ['name', 'secret'],
      properties: { name: { type: 'string' }, secret: { type: 'string' } },
    }),
    capability('secrets.exists', 'Check whether a named Keychain secret exists without revealing its value.', 'medium', [], true, false, {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    }),
    capability('secrets.delete', 'Delete a named Keychain secret.', 'high', [], true, false, {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    }),
    capability('secrets.fill_focused_field', 'Type a named Keychain secret into the currently focused field without returning it to chat.', 'high', ['accessibility'], true, false, {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    }),
    capability('automation.applescript', 'Run approved AppleScript for app automation.', 'high', ['automation', 'accessibility'], true, false, {
      type: 'object',
      required: ['script'],
      properties: { script: { type: 'string' }, timeoutMs: { type: 'number' } },
    }),
    capability('shell.run', 'Run a guarded local system command when shell access is enabled.', 'high', [], true, false, {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' } },
    }),
    capability('agent.ask_user', 'Ask the user a text question and wait for a response.', 'low', [], false, false, {
      type: 'object',
      properties: { message: { type: 'string' } },
    }),
    capability('agent.request_secret', 'Ask the user for a sensitive value without storing it in chat logs.', 'medium', [], false, false, {
      type: 'object',
      properties: { message: { type: 'string' } },
    }),
    capability('agent.request_approval', 'Ask the user to approve or deny a pending action.', 'medium', [], false, false, {
      type: 'object',
      properties: { message: { type: 'string' } },
    }),
  ];
}

export function getCapability(tool: string): DesktopCapability | undefined {
  return getCapabilityManifest().find((capability) => capability.name === tool);
}

export function validateCapabilityInput(tool: string, args: unknown): ValidationResult {
  const capability = getCapability(tool);
  if (!capability) {
    return { ok: false, error: `Unknown desktop capability: ${tool}` };
  }

  return validateInputSchema(capability.inputSchema, args || {});
}

export async function runCapability(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const runner = runners[request.tool];
  const auditContext = getAuditContext(request, settings);

  if (!runner) {
    appendAuditEntry({
      ...auditContext,
      action: 'tool.dispatch',
      result: 'denied',
      error: 'Unknown desktop capability',
    });
    return { ok: false, error: `Unknown desktop capability: ${request.tool}` };
  }

  const validation = validateCapabilityInput(request.tool, request.args || {});
  if (!validation.ok) {
    appendAuditEntry({
      ...auditContext,
      action: 'tool.validate',
      result: 'denied',
      error: validation.error,
    });
    return { ok: false, error: validation.error || 'Invalid capability input' };
  }

  appendAuditEntry({
    ...auditContext,
    action: 'tool.start',
    result: 'allowed',
  });

  try {
    const result = await runner(request, settings);
    appendAuditEntry({
      ...auditContext,
      action: 'tool.finish',
      result: result.ok ? 'completed' : 'failed',
      error: result.error,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendAuditEntry({
      ...auditContext,
      action: 'tool.exception',
      result: 'failed',
      error: message,
    });
    return { ok: false, error: message };
  }
}

function capability(
  name: string,
  description: string,
  risk: DesktopCapability['risk'],
  requiredMacPermissions: DesktopCapability['requiredMacPermissions'],
  requiresApproval: boolean,
  canRunUnattended: boolean,
  inputSchema: Record<string, unknown>,
): DesktopCapability {
  return {
    name,
    description,
    risk,
    requiredMacPermissions,
    requiresApproval,
    canRunUnattended,
    inputSchema,
    outputSchema: outputSchemaFor(name),
  };
}

function outputSchemaFor(tool: string): Record<string, unknown> {
  if (tool === 'browser.open_url') {
    return objectSchema({
      opened: stringSchema(),
      browser: stringSchema(),
    });
  }

  if (tool === 'apps.list') {
    return objectSchema({
      apps: arraySchema(objectSchema({ pid: numberSchema(), name: stringSchema(), path: stringSchema() })),
      count: numberSchema(),
      truncated: booleanSchema(),
    });
  }

  if (tool === 'apps.frontmost') {
    return objectSchema({
      name: stringSchema(),
      pid: numberSchema(),
      windowTitle: stringSchema(),
    });
  }

  if (tool === 'apps.open' || tool === 'apps.activate') {
    return objectSchema({ opened: stringSchema() });
  }

  if (tool === 'apps.quit') {
    return objectSchema({ quit: scalarSchema(['string', 'number']) });
  }

  if (tool === 'system.info') {
    return objectSchema({
      hostname: stringSchema(),
      platform: stringSchema(),
      arch: stringSchema(),
      release: stringSchema(),
      uptimeSeconds: numberSchema(),
      loadAverage: arraySchema(numberSchema()),
      cpu: objectSchema({ count: numberSchema(), model: stringSchema() }),
      memory: objectSchema({ totalBytes: numberSchema(), freeBytes: numberSchema() }),
    });
  }

  if (tool === 'system.storage') {
    return objectSchema({
      path: stringSchema(),
      volumes: arraySchema(objectSchema({
        filesystem: stringSchema(),
        sizeBytes: numberSchema(),
        usedBytes: numberSchema(),
        availableBytes: numberSchema(),
        capacity: stringSchema(),
        mount: stringSchema(),
      })),
      count: numberSchema(),
    });
  }

  if (tool === 'system.network') {
    return objectSchema({
      hostname: stringSchema(),
      addresses: arraySchema(objectSchema({
        name: stringSchema(),
        address: stringSchema(),
        family: stringSchema(),
        cidr: stringSchema(),
        mac: stringSchema(),
        internal: booleanSchema(),
        scopeid: numberSchema(),
      })),
      count: numberSchema(),
      includeInternal: booleanSchema(),
    });
  }

  if (tool === 'files.stat') {
    return objectSchema({
      path: stringSchema(),
      type: stringSchema(),
      size: numberSchema(),
      createdAt: stringSchema(),
      modifiedAt: stringSchema(),
    });
  }

  if (tool === 'files.list') {
    return objectSchema({
      path: stringSchema(),
      entries: arraySchema(fileEntrySchema()),
    });
  }

  if (tool === 'files.search') {
    return objectSchema({
      root: stringSchema(),
      query: stringSchema(),
      matches: arraySchema(objectSchema({ path: stringSchema(), type: stringSchema(), reason: stringSchema() })),
      truncated: booleanSchema(),
    });
  }

  if (tool === 'files.read') {
    return objectSchema({
      path: stringSchema(),
      size: numberSchema(),
      encoding: stringSchema(),
      content: stringSchema(),
    });
  }

  if (tool === 'files.tail') {
    return objectSchema({
      path: stringSchema(),
      size: numberSchema(),
      startByte: numberSchema(),
      bytesRead: numberSchema(),
      encoding: stringSchema(),
      lines: numberSchema(),
      truncated: booleanSchema(),
      content: stringSchema(),
    });
  }

  if (tool === 'files.write') {
    return objectSchema({ path: stringSchema(), bytes: numberSchema() });
  }

  if (tool === 'files.read_binary') {
    return objectSchema({
      path: stringSchema(),
      size: numberSchema(),
      encoding: literalSchema('base64'),
      contentBase64: stringSchema(),
    });
  }

  if (tool === 'files.write_binary') {
    return objectSchema({ path: stringSchema(), bytes: numberSchema(), encoding: literalSchema('base64') });
  }

  if (tool === 'files.mkdir') {
    return objectSchema({ path: stringSchema(), created: booleanSchema() });
  }

  if (tool === 'files.copy') {
    return objectSchema({
      sourcePath: stringSchema(),
      destinationPath: stringSchema(),
      type: stringSchema(),
      copied: booleanSchema(),
    });
  }

  if (tool === 'files.move') {
    return objectSchema({
      sourcePath: stringSchema(),
      destinationPath: stringSchema(),
      type: stringSchema(),
      moved: booleanSchema(),
    });
  }

  if (tool === 'files.delete') {
    return objectSchema({ path: stringSchema(), type: stringSchema(), deleted: booleanSchema() });
  }

  if (tool === 'files.open') {
    return objectSchema({ path: stringSchema(), type: stringSchema(), opened: booleanSchema() });
  }

  if (tool === 'files.reveal') {
    return objectSchema({ path: stringSchema(), type: stringSchema(), revealed: booleanSchema() });
  }

  if (tool === 'files.watch') {
    return objectSchema({
      path: stringSchema(),
      recursive: booleanSchema(),
      eventsSent: numberSchema(),
      intervalMs: numberSchema(),
      durationMs: numberSchema(),
    });
  }

  if (tool === 'screen.sources') {
    return objectSchema({
      sources: arraySchema(screenSourceSchema()),
      count: numberSchema(),
    });
  }

  if (tool === 'screen.screenshot') {
    return objectSchema({
      sourceId: stringSchema(),
      name: stringSchema(),
      sourceType: stringSchema(),
      displayId: stringSchema(),
      bounds: boundsSchema(),
      scaleFactor: numberSchema(),
      mimeType: stringSchema(),
      format: stringSchema(),
      quality: numberSchema(),
      width: numberSchema(),
      height: numberSchema(),
      data: stringSchema(),
    });
  }

  if (tool === 'screen.stream') {
    return objectSchema({
      framesSent: numberSchema(),
      intervalMs: numberSchema(),
      durationMs: numberSchema(),
    });
  }

  if (tool === 'input.type_text') {
    return objectSchema({ typedCharacters: numberSchema() });
  }

  if (tool === 'input.hotkey' || tool === 'input.press_key') {
    return objectSchema({ key: stringSchema(), modifiers: arraySchema(stringSchema()) });
  }

  if (tool === 'input.click') {
    return objectSchema({ x: numberSchema(), y: numberSchema(), button: stringSchema(), clickCount: numberSchema() });
  }

  if (tool === 'input.drag') {
    return objectSchema({
      fromX: numberSchema(),
      fromY: numberSchema(),
      toX: numberSchema(),
      toY: numberSchema(),
      durationMs: numberSchema(),
    });
  }

  if (tool === 'input.scroll') {
    return objectSchema({ deltaX: numberSchema(), deltaY: numberSchema(), x: numberSchema(), y: numberSchema() });
  }

  if (tool === 'clipboard.read_text') {
    return objectSchema({ content: stringSchema(), bytes: numberSchema() });
  }

  if (tool === 'clipboard.write_text') {
    return objectSchema({ bytes: numberSchema(), written: booleanSchema() });
  }

  if (tool === 'secrets.save') {
    return objectSchema({ name: stringSchema(), saved: booleanSchema() });
  }

  if (tool === 'secrets.exists') {
    return objectSchema({ name: stringSchema(), exists: booleanSchema() });
  }

  if (tool === 'secrets.delete') {
    return objectSchema({ name: stringSchema(), deleted: booleanSchema() });
  }

  if (tool === 'secrets.fill_focused_field') {
    return objectSchema({ name: stringSchema(), filled: booleanSchema() });
  }

  if (tool === 'automation.applescript' || tool === 'shell.run') {
    return objectSchema({ stdout: stringSchema(), stderr: stringSchema() });
  }

  if (tool === 'agent.ask_user' || tool === 'agent.request_secret' || tool === 'agent.request_approval') {
    return objectSchema({
      approved: booleanSchema(),
      scope: stringSchema(),
      value: stringSchema(),
      secret: literalSchema('[redacted]'),
      message: stringSchema(),
    });
  }

  return objectSchema({});
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', properties };
}

function arraySchema(items: Record<string, unknown>): Record<string, unknown> {
  return { type: 'array', items };
}

function stringSchema(): Record<string, unknown> {
  return { type: 'string' };
}

function numberSchema(): Record<string, unknown> {
  return { type: 'number' };
}

function booleanSchema(): Record<string, unknown> {
  return { type: 'boolean' };
}

function literalSchema(value: string): Record<string, unknown> {
  return { const: value };
}

function scalarSchema(types: string[]): Record<string, unknown> {
  return { anyOf: types.map((type) => ({ type })) };
}

function fileEntrySchema(): Record<string, unknown> {
  return objectSchema({ name: stringSchema(), path: stringSchema(), type: stringSchema() });
}

function screenSourceSchema(): Record<string, unknown> {
  return objectSchema({
    id: stringSchema(),
    name: stringSchema(),
    type: stringSchema(),
    displayId: stringSchema(),
    bounds: boundsSchema(),
    scaleFactor: numberSchema(),
  });
}

function boundsSchema(): Record<string, unknown> {
  return objectSchema({
    x: numberSchema(),
    y: numberSchema(),
    width: numberSchema(),
    height: numberSchema(),
  });
}

function getAuditContext(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): {
  deviceId?: string;
  jobId: string;
  ownerUserId?: string;
  targetDeviceId?: string;
  chatId?: string;
  tool: string;
  target?: string;
} {
  return {
    deviceId: settings.deviceId,
    jobId: request.jobId,
    ownerUserId: request.ownerUserId,
    targetDeviceId: request.targetDeviceId,
    chatId: request.chatId,
    tool: request.tool,
    target: summarizeAuditTarget(request.tool, request.args),
  };
}

export function summarizeAuditTarget(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;

  if (tool === 'browser.open_url' && typeof record.url === 'string') {
    return summarizeUrl(record.url);
  }

  if (tool.startsWith('files.')) {
    return summarizePathTarget(record);
  }

  if (tool.startsWith('apps.')) {
    return firstString(record.name, record.path, record.pid);
  }

  if (tool.startsWith('input.')) {
    const expected = typeof record.expectedFrontmostApp === 'string' ? ` app=${record.expectedFrontmostApp}` : '';
    if (tool === 'input.click') return `x=${record.x} y=${record.y}${expected}`;
    if (tool === 'input.drag') return `from=${record.fromX},${record.fromY} to=${record.toX},${record.toY}${expected}`;
    if (tool === 'input.scroll') return `delta=${record.deltaX || 0},${record.deltaY}${expected}`;
    if (tool === 'input.hotkey' || tool === 'input.press_key') return `key=${record.key}${expected}`;
    if (tool === 'input.type_text') return expected.trim() || 'focused field';
  }

  if (tool.startsWith('screen.')) {
    return firstString(record.sourceId, record.format);
  }

  if (tool.startsWith('secrets.')) {
    return typeof record.name === 'string' ? `secret:${record.name}` : undefined;
  }

  if (tool === 'automation.applescript') {
    return 'applescript';
  }

  if (tool === 'shell.run') {
    return firstString(record.command, record.cwd);
  }

  if (tool === 'system.storage') {
    return typeof record.path === 'string' ? record.path : undefined;
  }

  return undefined;
}

function summarizePathTarget(record: Record<string, unknown>): string | undefined {
  const source = firstString(record.path, record.sourcePath);
  const destination = firstString(record.destinationPath);
  if (source && destination) return `${source} -> ${destination}`;
  return source || destination;
}

function summarizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function filePathSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string' } },
  };
}
