import { execFile } from 'child_process';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';

const execFileAsync = promisify(execFile);
const MAX_SCRIPT_CHARS = 20000;

export async function runAutomationTool(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  if (request.tool !== 'automation.applescript') {
    return { ok: false, error: `Unsupported automation tool: ${request.tool}` };
  }

  if (settings.controlMode !== 'automation') {
    return { ok: false, error: 'AppleScript automation is disabled' };
  }

  const args = request.args as { script?: string; timeoutMs?: number };
  if (typeof args?.script !== 'string' || args.script.trim() === '') {
    return { ok: false, error: 'script is required' };
  }

  if (args.script.length > MAX_SCRIPT_CHARS) {
    return { ok: false, error: `script is too large (${args.script.length} characters)` };
  }

  if (containsSensitiveInlineSecret(args.script)) {
    return { ok: false, error: 'script appears to contain an inline secret' };
  }

  const timeout = Math.min(Math.max(args.timeoutMs || 15000, 1000), 60000);
  const result = await execFileAsync('/usr/bin/osascript', ['-e', args.script], {
    timeout,
    maxBuffer: 1024 * 1024,
  });

  return {
    ok: true,
    result: {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    },
  };
}

function containsSensitiveInlineSecret(script: string): boolean {
  return /password\s+["']|token\s*[:=]\s*["']|api[_-]?key\s*[:=]\s*["']/i.test(script);
}

