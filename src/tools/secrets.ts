import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';
import { deleteNamedSecret, loadNamedSecret, saveNamedSecret } from '../agent/keychain';

const execFileAsync = promisify(execFile);
const MAX_SECRET_CHARS = 20000;

export async function runSecretTool(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  switch (request.tool) {
    case 'secrets.save':
      return saveSecret(request, settings);
    case 'secrets.exists':
      return secretExists(request, settings);
    case 'secrets.delete':
      return deleteSecret(request, settings);
    case 'secrets.fill_focused_field':
      return fillFocusedField(request, settings);
    default:
      return { ok: false, error: `Unsupported secret tool: ${request.tool}` };
  }
}

async function saveSecret(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { name?: string; secret?: string };
  const name = validateSecretName(args?.name);

  if (typeof args?.secret !== 'string' || args.secret.length === 0) {
    return { ok: false, error: 'secret is required' };
  }

  if (args.secret.length > MAX_SECRET_CHARS) {
    return { ok: false, error: `secret is too large (${args.secret.length} characters)` };
  }

  await saveNamedSecret(secretAccount(settings, name), args.secret);
  return { ok: true, result: { name, saved: true } };
}

async function secretExists(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { name?: string };
  const name = validateSecretName(args?.name);
  const secret = await loadNamedSecret(secretAccount(settings, name));

  return {
    ok: true,
    result: {
      name,
      exists: typeof secret === 'string',
    },
  };
}

async function deleteSecret(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { name?: string };
  const name = validateSecretName(args?.name);

  await deleteNamedSecret(secretAccount(settings, name)).catch(() => undefined);
  return { ok: true, result: { name, deleted: true } };
}

async function fillFocusedField(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  if (!['keyboard_mouse', 'automation'].includes(settings.controlMode)) {
    return { ok: false, error: 'Keyboard and mouse control is disabled' };
  }

  const args = request.args as { name?: string };
  const name = validateSecretName(args?.name);
  const secret = await loadNamedSecret(secretAccount(settings, name));

  if (typeof secret !== 'string') {
    return { ok: false, error: `Secret not found: ${name}` };
  }

  await runAppleScript(`tell application "System Events" to keystroke ${appleScriptString(secret)}`);
  return { ok: true, result: { name, filled: true } };
}

function validateSecretName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error('name is required');
  }

  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('name is required');
  }

  if (trimmed.length > 120) {
    throw new Error('name must be 120 characters or fewer');
  }

  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('name must not contain control characters');
  }

  return trimmed;
}

function secretAccount(settings: DesktopAgentSettings, name: string): string {
  const owner = settings.ownerUserId || 'local-owner';
  const device = settings.deviceId || 'unpaired-device';
  const digest = createHash('sha256')
    .update(`${owner}\0${device}\0${name}`)
    .digest('hex');
  return `secret:${digest}`;
}

async function runAppleScript(script: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('macOS Accessibility automation is required');
  }

  await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 10000 });
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
